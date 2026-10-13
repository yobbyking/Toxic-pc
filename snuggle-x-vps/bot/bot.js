// Snuggle X Bot — runs as a pm2 process per user.
// Usage: node bot.js <sessionFolder>
//
// Features:
//   - LID-aware owner detection (with participantPn + async LID resolution)
//   - Three-tier access: Owner / Sudo / User
//   - BOT_MODE: public / silent / groups / dms
//   - Anti-commands with sub-options: antilink delete/warn/kick, antispam, antibadword, antidelete, antimention, antitag, antisticker
//   - Group commands: tagall, hidetag, promote, demote, kick, add
//   - .url uploads media to tmpfiles.org
//   - .menu replies with fake contact card (quoted) + menu text (one message)
//   - Owner commands: autofaketyping, autofakerecording, setmenuimage, setprefix

const {
  useMultiFileAuthState,
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const os = require('os');
const P = require('pino');
const { createFakeContact } = require('./createFakeContact');

// === Config ===
const sessionDir = process.argv[2];
if (!sessionDir || !fs.existsSync(sessionDir)) {
  console.error('Usage: node bot.js <sessionFolder>');
  process.exit(1);
}

let ownerJid = null;
let ownerName = 'Not Set!';
const credsFile = path.join(sessionDir, 'creds.json');
if (fs.existsSync(credsFile)) {
  try {
    const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
    if (creds.me && creds.me.id) { ownerJid = creds.me.id; ownerName = creds.me.name || 'Not Set!'; }
  } catch {}
}
const ownerNumber = ownerJid ? ownerJid.split(':')[0].split('@')[0] : null;
console.log(`[Snuggle X Bot] Owner: ${ownerNumber} (${ownerJid})`);

// === Files ===
const modeFile = path.join(sessionDir, 'mode.txt');
const sudoFile = path.join(sessionDir, 'sudos.txt');
const settingsFile = path.join(sessionDir, 'settings.json');
const prefixFile = path.join(sessionDir, 'prefix.txt');
const menuImageFile = path.join(sessionDir, 'menu-image.png');
const menuVideoFile = path.join(sessionDir, 'menu-video.mp4');
const autoFile = path.join(sessionDir, 'auto.json');

function getMode() { try { return fs.readFileSync(modeFile, 'utf-8').trim() || 'public'; } catch { return 'public'; } }
function setMode(m) { fs.writeFileSync(modeFile, m); }
function getSudos() { try { return fs.readFileSync(sudoFile, 'utf-8').split('\n').filter(x => x.trim()); } catch { return []; } }
function addSudo(n) { const s = getSudos(); if (!s.includes(n)) { s.push(n); fs.writeFileSync(sudoFile, s.join('\n')); } }
function removeSudo(n) { fs.writeFileSync(sudoFile, getSudos().filter(x => x !== n).join('\n')); }
function getSettings() { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf-8')); } catch { return {}; } }
function saveSettings(s) { fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); }
function getPrefix() { try { const p = fs.readFileSync(prefixFile, 'utf-8').trim(); return p === 'none' ? '' : p; } catch { return '.'; } }
function setPrefix(p) { fs.writeFileSync(prefixFile, p); }
function getAuto() { try { return JSON.parse(fs.readFileSync(autoFile, 'utf-8')); } catch { return { faketyping: false, fakerecording: false }; } }
function saveAuto(a) { fs.writeFileSync(autoFile, JSON.stringify(a, null, 2)); }
function getChatbot() { try { const s = getSettings(); return s.chatbot === true; } catch { return false; } }
function setChatbot(on) { const s = getSettings(); s.chatbot = on; saveSettings(s); }
function getGeminiKey() { try { return fs.readFileSync(path.join(sessionDir, 'gemini-key.txt'), 'utf-8').trim(); } catch { return ''; } }
function setGeminiKey(k) { fs.writeFileSync(path.join(sessionDir, 'gemini-key.txt'), k); }

// === LID cache ===
const lidPhoneCache = new Map();
const phoneLidCache = new Map();
function cacheLidPhone(lid, phone) { lidPhoneCache.set(lid, phone); phoneLidCache.set(phone, lid); }
function resolvePhoneFromLid(jid) {
  if (!jid || !jid.includes('@lid')) return null;
  return lidPhoneCache.get(jid.split('@')[0].split(':')[0]) || null;
}

// === Access control ===
function isOwner(senderJid, participantPn) {
  if (!senderJid) return false;
  // Direct phone match
  const phone = senderJid.split('@')[0].split(':')[0];
  if (phone === ownerNumber) return true;
  // participantPn match (group messages with LID) — this is the critical fix for groups
  if (participantPn) {
    const pn = participantPn.split('@')[0].split(':')[0];
    if (pn === ownerNumber) return true;
  }
  // LID → cached phone match
  if (senderJid.endsWith('@lid')) {
    const cached = resolvePhoneFromLid(senderJid);
    if (cached && cached === ownerNumber) return true;
    // Also try the raw LID number as a direct comparison (some accounts use long LIDs that match)
    const lidRaw = senderJid.split('@')[0].split(':')[0];
    if (lidRaw === ownerNumber) return true;
  }
  return false;
}
function isSudo(senderJid, participantPn) {
  if (!senderJid) return false;
  const sudos = getSudos();
  if (sudos.length === 0) return false;
  const phone = senderJid.split('@')[0].split(':')[0];
  if (sudos.includes(phone)) return true;
  if (participantPn) { const pn = participantPn.split('@')[0].split(':')[0]; if (sudos.includes(pn)) return true; }
  if (senderJid.endsWith('@lid')) { const c = resolvePhoneFromLid(senderJid); if (c && sudos.includes(c)) return true; }
  return false;
}

// === Anti-spam cache ===
const antiSpamCache = new Map();

// === Check if bot is admin in a group ===
async function isBotAdmin(sock, chatId) {
  try {
    const meta = await sock.groupMetadata(chatId);
    const botId = sock.user.id;
    const botCleanId = botId.split(':')[0].split('@')[0];
    return meta.participants.some(p => {
      const pId = p.id.split(':')[0].split('@')[0];
      return (p.id === botId || pId === botCleanId) && (p.admin === 'admin' || p.admin === 'superadmin');
    });
  } catch { return false; }
}

// === Menu image/video cache ===
let menuImageBuffer = null;
let menuVideoBuffer = null;
let menuVideoMime = null;
function loadMenuImage() {
  if (menuImageBuffer) return menuImageBuffer;
  if (fs.existsSync(menuImageFile)) { try { menuImageBuffer = fs.readFileSync(menuImageFile); return menuImageBuffer; } catch {} }
  return null;
}
function loadMenuVideo() {
  if (menuVideoBuffer) return { buffer: menuVideoBuffer, mime: menuVideoMime };
  if (fs.existsSync(menuVideoFile)) { try { menuVideoBuffer = fs.readFileSync(menuVideoFile); menuVideoMime = fs.existsSync(path.join(sessionDir, 'menu-video-mime.txt')) ? fs.readFileSync(path.join(sessionDir, 'menu-video-mime.txt'), 'utf-8').trim() : 'video/mp4'; return { buffer: menuVideoBuffer, mime: menuVideoMime }; } catch {} }
  return null;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  const logger = P({ level: 'warn' }, P.destination({ sync: true }));

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    logger,
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: 120000,
    connectTimeoutMs: 120000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 2000,
    linkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  let isStarting = true;
  sock.ev.on('connection.update', async (update) => {
    if (update.connection === 'open') {
      console.log('[Snuggle X Bot] ✅ Connected as', sock.user.id);
      if (isStarting) {
        isStarting = false;
        setTimeout(() => {
          try { sock.sendMessage(ownerJid, { text: '*`SNUGGLE X BOT IS NOW LIVE ✅`*\n> snuggle x bot\n\nType *.menu* to see commands.\nType *.all* to see the full command list.' }); }
          catch (e) { console.error('[LIVE] send failed:', e.message); }
        }, 3000);
      }
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      console.log('[Snuggle X Bot] closed:', code);
      if (code === DisconnectReason.loggedOut) { console.error('[Snuggle X Bot] ❌ Session logged out.'); setTimeout(() => process.exit(1), 3000); }
      else if (code === 503) setTimeout(() => start(), 30000);
      else setTimeout(() => start(), 5000);
    }
  });

  // === Presence (auto fake typing/recording) ===
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const m = messages[0];
      if (!m || !m.message) return;

      const chatId = m.key.remoteJid;
      if (chatId && (chatId.includes('newsletter') || chatId.includes('broadcast'))) return;

      // Auto fake typing/recording
      const auto = getAuto();
      if (auto.faketyping || auto.fakerecording) {
        try {
          const presence = auto.faketyping ? 'composing' : 'recording';
          await sock.sendPresenceUpdate(presence, chatId);
        } catch {}
      }

      const isGroup = chatId && chatId.endsWith('@g.us');
      const participant = m.key.participant || chatId;
      const participantPn = m.key.participantPn || null;
      if (participantPn && participant && participant.endsWith('@lid')) {
        cacheLidPhone(participant.split('@')[0].split(':')[0], participantPn.split('@')[0].split(':')[0]);
      }

      const isLid = chatId && chatId.endsWith('@lid');
      const senderPhone = chatId ? chatId.split('@')[0].split(':')[0] : '';
      const isSelfChat = (senderPhone === ownerNumber && chatId && chatId.endsWith('@s.whatsapp.net')) || (isLid && m.key.fromMe);
      if (m.key.fromMe && !isSelfChat) return;

      let senderJid = isGroup ? participant : chatId;
      const senderNumber = senderJid ? senderJid.split(':')[0].split('@')[0] : '';
      const pushName = m.pushName || (isSelfChat ? 'You' : 'User');
      const ownerCheck = isOwner(senderJid, participantPn) || isSelfChat;
      const sudoCheck = isSudo(senderJid, participantPn);
      const mode = getMode();
      const prefix = getPrefix();

      // === Extract text ===
      const msg = m.message;
      let text = '';
      if (msg.conversation) text = msg.conversation;
      else if (msg.extendedTextMessage?.text) text = msg.extendedTextMessage.text;
      else if (msg.imageMessage?.caption) text = msg.imageMessage.caption;
      else if (msg.videoMessage?.caption) text = msg.videoMessage.caption;
      else if (msg.viewOnceMessage?.message?.imageMessage?.caption) text = msg.viewOnceMessage.message.imageMessage.caption;
      else if (msg.viewOnceMessage?.message?.videoMessage?.caption) text = msg.viewOnceMessage.message.videoMessage.caption;
      else return;

      const raw = text.trim();
      if (!raw) return;
      const lower = raw.toLowerCase();

      // === Anti-features for groups ===
      if (isGroup) {
        const settings = getSettings();
        const gs = settings[chatId] || {};
        if (!ownerCheck && !sudoCheck) {
          const botIsAdmin = await isBotAdmin(sock, chatId);
          // Anti-link
          if (gs.antilink && gs.antilink !== 'off') {
            const urlPattern = /https?:\/\/|www\.|\.com|\.net|\.org|wa\.me\/|chat\.whatsapp\.com/i;
            if (urlPattern.test(raw)) {
              await doAntiAction(sock, chatId, m, senderJid, senderNumber, gs.antilink, 'link');
              return;
            }
          }
          // Anti-mention
          if (gs.antimention && gs.antimention !== 'off') {
            if (msg.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0 || /@\d+/.test(raw)) {
              await doAntiAction(sock, chatId, m, senderJid, senderNumber, gs.antimention, 'mention');
              return;
            }
          }
          // Anti-tag (anti-tagall)
          if (gs.antitag && gs.antitag !== 'off') {
            if (msg.extendedTextMessage?.contextInfo?.mentionedJid?.length > 5) {
              await doAntiAction(sock, chatId, m, senderJid, senderNumber, gs.antitag, 'tag');
              return;
            }
          }
          // Anti-sticker
          if (gs.antisticker && gs.antisticker !== 'off') {
            if (msg.stickerMessage) {
              await doAntiAction(sock, chatId, m, senderJid, senderNumber, gs.antisticker, 'sticker');
              return;
            }
          }
          // Anti-badword
          if (gs.antibadword && gs.antibadword !== 'off') {
            const badwords = ['fuck', 'shit', 'bitch', 'asshole', 'dick', 'pussy', 'cunt'];
            if (badwords.some(w => lower.includes(w))) {
              await doAntiAction(sock, chatId, m, senderJid, senderNumber, gs.antibadword, 'badword');
              return;
            }
          }
          // Anti-spam
          if (gs.antispam && gs.antispam !== 'off') {
            const now = Date.now();
            const key = chatId + senderNumber;
            if (!antiSpamCache.has(key)) antiSpamCache.set(key, []);
            const arr = antiSpamCache.get(key);
            arr.push(now);
            while (arr.length > 0 && arr[0] < now - 10000) arr.shift();
            if (arr.length > 5) {
              await doAntiAction(sock, chatId, m, senderJid, senderNumber, gs.antispam, 'spam');
              return;
            }
          }
        }
      }

      // === Parse command ===
      const cmdText = raw.replace(/^[*_`~]+/, '').trim();
      const cmd = cmdText.toLowerCase().split(/\s+/)[0];
      const args = cmdText.split(/\s+/).slice(1);
      const argText = args.join(' ');

      // === BOT_MODE checks ===
      if (mode === 'silent' && !ownerCheck && !sudoCheck) return;
      if (mode === 'groups' && !isGroup && !ownerCheck && !sudoCheck) return;
      if (mode === 'dms' && isGroup && !ownerCheck && !sudoCheck) return;

      // === AI Chatbot (DMs only — reply with Gemini AI) ===
      if (getChatbot() && !isGroup && !cmd.startsWith(prefix) && !cmd.startsWith('.') && !cmd.startsWith('!') && !cmd.startsWith('/')) {
        const geminiKey = getGeminiKey();
        if (geminiKey) {
          try {
            await sock.sendPresenceUpdate('composing', chatId);
            const axios = require('axios');
            const aiRes = await axios.post(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
              {
                contents: [{
                  parts: [{
                    text: `You are Snuggle X, a helpful WhatsApp bot assistant. Reply concisely (max 200 chars). User: ${raw}`,
                  }],
                }],
              },
              { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
            );
            const aiText = aiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (aiText) {
              await sock.sendMessage(chatId, { text: aiText.trim() }, { quoted: m });
              console.log(`[CHATBOT] ${senderNumber}: "${raw.slice(0, 40)}" → "${aiText.slice(0, 40)}..."`);
              return;
            }
          } catch (e) {
            console.error('[CHATBOT] Gemini error:', e.message);
            // Fall through to command handling
          }
        }
      }

      // === PUBLIC commands (work for everyone) ===
      if (cmd === `${prefix}menu` || cmd === '.menu' || lower === 'menu') {
        const fakeContact = createFakeContact(ownerNumber, ownerName);
        const menuText = buildMenu(pushName);
        const menuImg = loadMenuImage();
        const menuVid = loadMenuVideo();
        try {
          if (menuVid) {
            // Send video with menu text as caption (autoplay in WhatsApp)
            await sock.sendMessage(chatId, { video: menuVid.buffer, caption: menuText, mimetype: menuVid.mime, gifPlayback: true }, { quoted: fakeContact });
          } else if (menuImg) {
            await sock.sendMessage(chatId, { image: menuImg, caption: menuText }, { quoted: fakeContact });
          } else {
            await sock.sendMessage(chatId, { text: menuText }, { quoted: fakeContact });
          }
        } catch (e) {
          console.error('Menu send failed:', e.message);
          await sock.sendMessage(chatId, { text: menuText }, { quoted: m });
        }
        return;
      }
      if (cmd === `${prefix}all` || cmd === '.all' || lower === 'all') {
        await sock.sendMessage(chatId, { text: buildAllMenu() }, { quoted: m });
        return;
      }
      if (cmd === `${prefix}ping` || cmd === '.ping') {
        const t = Date.now();
        await sock.sendMessage(chatId, { text: `*PONG* 🏓\nLatency: ${Date.now() - t}ms` }, { quoted: m });
        return;
      }
      if (cmd === `${prefix}help` || cmd === '.help') {
        await sock.sendMessage(chatId, { text: `Type *${prefix}menu* for the menu, or *${prefix}all* for the full command list.` }, { quoted: m });
        return;
      }
      if (cmd === `${prefix}whoami` || cmd === '.whoami') {
        await sock.sendMessage(chatId, { text: `*You are* ${pushName}\n*Number:* ${senderNumber}\n*Status:* ${ownerCheck ? 'Owner 👑' : sudoCheck ? 'Sudo 🔑' : 'User'}` }, { quoted: m });
        return;
      }
      // Sticker and URL are PUBLIC — anyone can use them
      if (cmd === `${prefix}sticker` || cmd === '.sticker') {
        await handleStickerCommand(sock, chatId, m, msg);
        return;
      }
      if (cmd === `${prefix}url` || cmd === '.url') {
        await handleUrlCommand(sock, chatId, m, msg);
        return;
      }

      // === ACCESS GATE — owner/sudo only beyond this point ===
      if (!ownerCheck && !sudoCheck) {
        if (mode === 'private' || mode === 'silent') {
          await sock.sendMessage(chatId, { text: '> *only sudo access 🚫*\n> Get yours 0181163563 ✅' }, { quoted: m });
          return;
        }
        const ownerOnlyCmds = ['alive','owner','mode','addsudo','delsudo','sudolist','tagall','hidetag','promote','demote','kick','add','antilink','antispam','antibadword','antidelete','antimention','antitag','antisticker','autofaketyping','autofakerecording','setmenuimage','setmenuvideo','setprefix','chatbot','setgeminikey','vv'];
        if (ownerOnlyCmds.some(c => cmd === `.${c}` || cmd === `!${c}` || cmd === `/${c}` || cmd === `${prefix}${c}`)) {
          await sock.sendMessage(chatId, { text: '> *only sudo access 🚫*\n> Get yours 0181163563 ✅' }, { quoted: m });
          return;
        }
        if (cmd.startsWith('.') || cmd.startsWith('!') || cmd.startsWith('/') || (prefix && cmd.startsWith(prefix))) {
          await sock.sendMessage(chatId, { text: `Unknown command: ${cmd}\nType *${prefix}menu* to see the menu.` }, { quoted: m });
        }
        return;
      }

      // === OWNER/SUDO commands ===
      switch (cmd) {
        case `${prefix}alive`: case '.alive': await sock.sendMessage(chatId, { text: buildAlive() }, { quoted: m }); break;
        case `${prefix}owner`: case '.owner': await sock.sendMessage(chatId, { text: buildOwner() }, { quoted: m }); break;

        case `${prefix}mode`: case '.mode': {
          if (['private','public','silent','groups','dms'].includes(argText)) {
            if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
            setMode(argText);
            await sock.sendMessage(chatId, { text: `*MODE CHANGED* ✅\n> Bot is now in *${argText}* mode` }, { quoted: m });
          } else {
            await sock.sendMessage(chatId, { text: `*Current mode:* ${getMode()}\n*Current prefix:* ${prefix === '' ? '(none)' : prefix}\n\nUsage:\n*.mode public/private/silent/groups/dms*` }, { quoted: m });
          }
          break;
        }

        // === Sudo management ===
        case `${prefix}addsudo`: case '.addsudo': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const n = args[0]?.replace(/[^0-9]/g, '');
          if (!n) { await sock.sendMessage(chatId, { text: 'Usage: .addsudo <number>' }, { quoted: m }); return; }
          addSudo(n); await sock.sendMessage(chatId, { text: `✅ Added ${n} as sudo` }, { quoted: m }); break;
        }
        case `${prefix}delsudo`: case '.delsudo': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const n = args[0]?.replace(/[^0-9]/g, '');
          if (!n) { await sock.sendMessage(chatId, { text: 'Usage: .delsudo <number>' }, { quoted: m }); return; }
          removeSudo(n); await sock.sendMessage(chatId, { text: `✅ Removed ${n} from sudo` }, { quoted: m }); break;
        }
        case `${prefix}sudolist`: case '.sudolist': {
          const s = getSudos();
          await sock.sendMessage(chatId, { text: `*Sudo users (${s.length}):*\n${s.length > 0 ? s.map(x => '• ' + x).join('\n') : 'None'}` }, { quoted: m }); break;
        }

        // === Group management ===
        case `${prefix}tagall`: case '.tagall': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          try {
            const meta = await sock.groupMetadata(chatId);
            const mentions = meta.participants.map(p => p.id);
            const t = `┏▣ *SNUGGLE X TAG ALL* ▣\n┗▣ Total: ${mentions.length} members\n\n` + mentions.map(p => '➽ @' + p.split('@')[0]).join('\n');
            await sock.sendMessage(chatId, { text: t, mentions });
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}hidetag`: case '.hidetag': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          try {
            const meta = await sock.groupMetadata(chatId);
            const mentions = meta.participants.map(p => p.id);
            await sock.sendMessage(chatId, { text: argText || '👥', mentions });
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}promote`: case '.promote': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          if (!(await isBotAdmin(sock, chatId))) { await sock.sendMessage(chatId, { text: 'Bot is not admin. Make the bot admin first.' }, { quoted: m }); return; }
          const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!target) { await sock.sendMessage(chatId, { text: 'Mention a user' }, { quoted: m }); return; }
          try { await sock.groupParticipantsUpdate(chatId, [target], 'promote'); await sock.sendMessage(chatId, { text: `✅ Promoted @${target.split('@')[0]}`, mentions: [target] }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}demote`: case '.demote': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          if (!(await isBotAdmin(sock, chatId))) { await sock.sendMessage(chatId, { text: 'Bot is not admin. Make the bot admin first.' }, { quoted: m }); return; }
          const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!target) { await sock.sendMessage(chatId, { text: 'Mention a user' }, { quoted: m }); return; }
          try { await sock.groupParticipantsUpdate(chatId, [target], 'demote'); await sock.sendMessage(chatId, { text: `✅ Demoted @${target.split('@')[0]}`, mentions: [target] }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}kick`: case '.kick': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!target) { await sock.sendMessage(chatId, { text: 'Mention a user' }, { quoted: m }); return; }
          try { await sock.groupParticipantsUpdate(chatId, [target], 'remove'); await sock.sendMessage(chatId, { text: `✅ Kicked @${target.split('@')[0]}`, mentions: [target] }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}add`: case '.add': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          if (!(await isBotAdmin(sock, chatId))) { await sock.sendMessage(chatId, { text: 'Bot is not admin. Make the bot admin first.' }, { quoted: m }); return; }
          const n = args[0]?.replace(/[^0-9]/g, '');
          if (!n) { await sock.sendMessage(chatId, { text: 'Usage: .add <number>' }, { quoted: m }); return; }
          try { const t = `${n}@s.whatsapp.net`; await sock.groupParticipantsUpdate(chatId, [t], 'add'); await sock.sendMessage(chatId, { text: `✅ Added ${n}`, mentions: [t] }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }

        // === Anti-commands with sub-options ===
        case `${prefix}antilink`: case '.antilink': { await toggleAnti(sock, chatId, m, args, 'antilink', 'link'); break; }
        case `${prefix}antispam`: case '.antispam': { await toggleAnti(sock, chatId, m, args, 'antispam', 'spam'); break; }
        case `${prefix}antibadword`: case '.antibadword': { await toggleAnti(sock, chatId, m, args, 'antibadword', 'badword'); break; }
        case `${prefix}antidelete`: case '.antidelete': { await toggleAnti(sock, chatId, m, args, 'antidelete', 'delete'); break; }
        case `${prefix}antimention`: case '.antimention': { await toggleAnti(sock, chatId, m, args, 'antimention', 'mention'); break; }
        case `${prefix}antitag`: case '.antitag': { await toggleAnti(sock, chatId, m, args, 'antitag', 'tag'); break; }
        case `${prefix}antisticker`: case '.antisticker': { await toggleAnti(sock, chatId, m, args, 'antisticker', 'sticker'); break; }

        // === Auto fake typing/recording ===
        case `${prefix}autofaketyping`: case '.autofaketyping': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const a = getAuto();
          if (argText === 'all on' || argText === 'on') { a.faketyping = true; saveAuto(a); await sock.sendMessage(chatId, { text: '✅ Auto fake typing ON' }, { quoted: m }); }
          else if (argText === 'all off' || argText === 'off') { a.faketyping = false; saveAuto(a); await sock.sendMessage(chatId, { text: '❌ Auto fake typing OFF' }, { quoted: m }); }
          else { await sock.sendMessage(chatId, { text: `*Auto fake typing:* ${a.faketyping ? 'ON ✅' : 'OFF ❌'}\n\nUsage:\n.autofaketyping all on\n.autofaketyping all off` }, { quoted: m }); }
          break;
        }
        case `${prefix}autofakerecording`: case '.autofakerecording': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const a = getAuto();
          if (argText === 'all on' || argText === 'on') { a.fakerecording = true; saveAuto(a); await sock.sendMessage(chatId, { text: '✅ Auto fake recording ON' }, { quoted: m }); }
          else if (argText === 'all off' || argText === 'off') { a.fakerecording = false; saveAuto(a); await sock.sendMessage(chatId, { text: '❌ Auto fake recording OFF' }, { quoted: m }); }
          else { await sock.sendMessage(chatId, { text: `*Auto fake recording:* ${a.fakerecording ? 'ON ✅' : 'OFF ❌'}\n\nUsage:\n.autofakerecording all on\n.autofakerecording all off` }, { quoted: m }); }
          break;
        }

        // === Set menu image ===
        case `${prefix}setmenuimage`: case '.setmenuimage': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          try {
            if (args[0]?.startsWith('http')) {
              // Download from URL
              const axios = require('axios');
              const res = await axios.get(args[0], { responseType: 'arraybuffer', timeout: 30000 });
              fs.writeFileSync(menuImageFile, Buffer.from(res.data));
              menuImageBuffer = null;
              await sock.sendMessage(chatId, { text: '✅ Menu image set from URL' }, { quoted: m });
            } else if (msg.imageMessage) {
              // This message has an image (sent with caption .setmenuimage)
              const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: P({ level: 'silent' }) });
              fs.writeFileSync(menuImageFile, Buffer.from(buf));
              menuImageBuffer = null;
              await sock.sendMessage(chatId, { text: '✅ Menu image set from sent image' }, { quoted: m });
            } else if (msg.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
              // Reply to an image message
              const quoted = msg.extendedTextMessage.contextInfo.quotedMessage;
              const targetMsg = {
                key: {
                  remoteJid: chatId,
                  id: msg.extendedTextMessage.contextInfo.stanzaId,
                  participant: msg.extendedTextMessage.contextInfo.participant,
                  fromMe: msg.extendedTextMessage.contextInfo.fromMe || false,
                },
                message: quoted,
              };
              const buf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
              fs.writeFileSync(menuImageFile, Buffer.from(buf));
              menuImageBuffer = null;
              await sock.sendMessage(chatId, { text: '✅ Menu image set from replied image' }, { quoted: m });
            } else {
              await sock.sendMessage(chatId, { text: 'Usage:\n.setmenuimage <url> — set from URL\n.setmenuimage (reply to image) — set from replied image\n.setmenuimage (send image with caption) — set from sent image' }, { quoted: m });
            }
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }

        // === Set menu video (reply to a video → set as menu video) ===
        case `${prefix}setmenuvideo`: case '.setmenuvideo': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          try {
            if (args[0]?.startsWith('http')) {
              const axios = require('axios');
              const res = await axios.get(args[0], { responseType: 'arraybuffer', timeout: 60000 });
              fs.writeFileSync(menuVideoFile, Buffer.from(res.data));
              fs.writeFileSync(path.join(sessionDir, 'menu-video-mime.txt'), 'video/mp4');
              menuVideoBuffer = null;
              await sock.sendMessage(chatId, { text: '✅ Menu video set from URL' }, { quoted: m });
            } else if (msg.videoMessage) {
              const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: P({ level: 'silent' }) });
              fs.writeFileSync(menuVideoFile, Buffer.from(buf));
              fs.writeFileSync(path.join(sessionDir, 'menu-video-mime.txt'), msg.videoMessage.mimetype || 'video/mp4');
              menuVideoBuffer = null;
              await sock.sendMessage(chatId, { text: '✅ Menu video set from sent video' }, { quoted: m });
            } else if (msg.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage) {
              const quoted = msg.extendedTextMessage.contextInfo.quotedMessage;
              const targetMsg = { key: { remoteJid: chatId, id: msg.extendedTextMessage.contextInfo.stanzaId, participant: msg.extendedTextMessage.contextInfo.participant, fromMe: msg.extendedTextMessage.contextInfo.fromMe || false }, message: quoted };
              const buf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
              fs.writeFileSync(menuVideoFile, Buffer.from(buf));
              fs.writeFileSync(path.join(sessionDir, 'menu-video-mime.txt'), quoted.videoMessage.mimetype || 'video/mp4');
              menuVideoBuffer = null;
              await sock.sendMessage(chatId, { text: '✅ Menu video set from replied video' }, { quoted: m });
            } else {
              await sock.sendMessage(chatId, { text: 'Usage:\n.setmenuvideo <url>\n.setmenuvideo (reply to video)\n.setmenuvideo (send video with caption)' }, { quoted: m });
            }
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }

        // === .vv — View-once unlock (owner only) ===
        // Reply to a view-once media with .vv → unlock it, send to owner's DM privately
        case `${prefix}vv`: case '.vv': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          try {
            const quoted = msg.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) { await sock.sendMessage(chatId, { text: 'Reply to a view-once media message with .vv' }, { quoted: m }); return; }
            // Check if it's view-once
            const isVO = !!(quoted.imageMessage?.viewOnce || quoted.videoMessage?.viewOnce || quoted.audioMessage?.viewOnce ||
                           quoted.viewOnceMessageV2 || quoted.viewOnceMessage || quoted.viewOnceMessageV2Extension);
            if (!isVO) { await sock.sendMessage(chatId, { text: 'The replied message is not a view-once media.' }, { quoted: m }); return; }
            // React with ⏳
            await sock.sendMessage(chatId, { react: { text: '⏳', key: m.key } });
            // Reconstruct the message for download
            const targetMsg = {
              key: { remoteJid: chatId, id: msg.extendedTextMessage.contextInfo.stanzaId, participant: msg.extendedTextMessage.contextInfo.participant, fromMe: msg.extendedTextMessage.contextInfo.fromMe || false },
              message: quoted,
            };
            const buf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
            const buffer = Buffer.from(buf);
            if (!buffer || buffer.length === 0) throw new Error('Empty buffer');
            // Determine type
            let mediaType = 'image', mime = 'image/jpeg';
            if (quoted.videoMessage) { mediaType = 'video'; mime = quoted.videoMessage.mimetype || 'video/mp4'; }
            else if (quoted.audioMessage) { mediaType = 'audio'; mime = quoted.audioMessage.mimetype || 'audio/mpeg'; }
            else if (quoted.imageMessage) { mediaType = 'image'; mime = quoted.imageMessage.mimetype || 'image/jpeg'; }
            else if (quoted.viewOnceMessageV2?.message?.imageMessage) { mediaType = 'image'; mime = quoted.viewOnceMessageV2.message.imageMessage.mimetype || 'image/jpeg'; }
            else if (quoted.viewOnceMessageV2?.message?.videoMessage) { mediaType = 'video'; mime = quoted.viewOnceMessageV2.message.videoMessage.mimetype || 'video/mp4'; }
            // Send to owner's DM
            const caption = `🔓 *View-once unlocked by Snuggle X*\n_Type: ${mediaType}_\n_Size: ${(buffer.length / 1024).toFixed(1)} KB_`;
            if (mediaType === 'video') { await sock.sendMessage(ownerJid, { video: buffer, caption, mimetype: mime }); }
            else if (mediaType === 'audio') { await sock.sendMessage(ownerJid, { audio: buffer, mimetype: mime }); }
            else { await sock.sendMessage(ownerJid, { image: buffer, caption, mimetype: mime }); }
            // React ✅ on success
            await sock.sendMessage(chatId, { react: { text: '✅', key: m.key } });
            console.log(`[VV] Unlocked ${mediaType} sent to owner DM`);
          } catch (e) {
            console.error('[VV] failed:', e.message);
            await sock.sendMessage(chatId, { react: { text: '❌', key: m.key } });
            await sock.sendMessage(chatId, { text: `❌ Failed: ${e.message}` }, { quoted: m });
          }
          break;
        }

        // === .song — download from YouTube as MP3 ===
        case `${prefix}song`: case '.song': {
          const query = argText;
          if (!query) { await sock.sendMessage(chatId, { text: 'Usage: .song <song name>\nExample: .song memories maroon 5' }, { quoted: m }); return; }
          await sock.sendMessage(chatId, { text: `🎵 Searching for: ${query}...` }, { quoted: m });
          try {
            const { execSync } = require('child_process');
            const tmpFile = `/tmp/snuggle-song-${Date.now()}.mp3`;
            // Use yt-dlp to search + download as MP3
            const cmd = `yt-dlp --no-playlist --extract-audio --audio-format mp3 --audio-quality 0 -o "${tmpFile}" "ytsearch1:${query.replace(/"/g, '')}" 2>&1`;
            const output = execSync(cmd, { timeout: 120000, encoding: 'utf-8' });
            if (!fs.existsSync(tmpFile)) throw new Error('Download failed — song not found');
            const buffer = fs.readFileSync(tmpFile);
            // Get video title
            const titleMatch = output.match(/\[info\] \w+: (.+)/);
            const title = titleMatch ? titleMatch[1].split(' [')[0] : query;
            await sock.sendMessage(chatId, {
              audio: buffer,
              mimetype: 'audio/mpeg',
              fileName: `${title}.mp3`,
              caption: `🎵 *${title}*\n_Downloaded by Snuggle X_`,
            }, { quoted: m });
            fs.unlinkSync(tmpFile);
            console.log(`[SONG] Sent: ${title}`);
          } catch (e) { await sock.sendMessage(chatId, { text: `❌ Failed: ${e.message}` }, { quoted: m }); }
          break;
        }

        // === .video — download from YouTube as MP4 ===
        case `${prefix}video`: case '.video': {
          const query = argText;
          if (!query) { await sock.sendMessage(chatId, { text: 'Usage: .video <video name>\nExample: .video funny cat compilation' }, { quoted: m }); return; }
          await sock.sendMessage(chatId, { text: `🎬 Searching for: ${query}...` }, { quoted: m });
          try {
            const { execSync } = require('child_process');
            const tmpFile = `/tmp/snuggle-video-${Date.now()}.mp4`;
            // Use yt-dlp to search + download as MP4 (max 50MB)
            const cmd = `yt-dlp --no-playlist -f "best[ext=mp4][filesize<50M]/best[ext=mp4]/best" -o "${tmpFile}" "ytsearch1:${query.replace(/"/g, '')}" 2>&1`;
            const output = execSync(cmd, { timeout: 180000, encoding: 'utf-8' });
            if (!fs.existsSync(tmpFile)) throw new Error('Download failed — video not found or too large');
            const buffer = fs.readFileSync(tmpFile);
            if (buffer.length > 60 * 1024 * 1024) { fs.unlinkSync(tmpFile); throw new Error('Video too large (>60MB)'); }
            const titleMatch = output.match(/\[info\] \w+: (.+)/);
            const title = titleMatch ? titleMatch[1].split(' [')[0] : query;
            await sock.sendMessage(chatId, {
              video: buffer,
              mimetype: 'video/mp4',
              fileName: `${title}.mp4`,
              caption: `🎬 *${title}*\n_Size: ${(buffer.length / 1024 / 1024).toFixed(1)} MB_\n_Downloaded by Snuggle X_`,
            }, { quoted: m });
            fs.unlinkSync(tmpFile);
            console.log(`[VIDEO] Sent: ${title}`);
          } catch (e) { await sock.sendMessage(chatId, { text: `❌ Failed: ${e.message}` }, { quoted: m }); }
          break;
        }

        // === Set prefix ===
        case `${prefix}setprefix`: case '.setprefix': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const newPrefix = argText.trim();
          if (newPrefix === 'none' || newPrefix === '') { setPrefix('none'); await sock.sendMessage(chatId, { text: '✅ Prefix removed (no prefix needed for commands)' }, { quoted: m }); }
          else { setPrefix(newPrefix); await sock.sendMessage(chatId, { text: `✅ Prefix set to: ${newPrefix}` }, { quoted: m }); }
          break;
        }

        // === AI Chatbot ===
        case `${prefix}chatbot`: case '.chatbot': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          if (argText === 'on') {
            if (!getGeminiKey()) { await sock.sendMessage(chatId, { text: '❌ Set Gemini API key first: .setgeminikey <key>\n\nGet a free key at: https://aistudio.google.com/app/apikey' }, { quoted: m }); return; }
            setChatbot(true); await sock.sendMessage(chatId, { text: '✅ AI Chatbot ON — I will reply to DMs using Gemini AI' }, { quoted: m });
          } else if (argText === 'off') {
            setChatbot(false); await sock.sendMessage(chatId, { text: '❌ AI Chatbot OFF' }, { quoted: m });
          } else {
            await sock.sendMessage(chatId, { text: `*AI Chatbot:* ${getChatbot() ? 'ON ✅' : 'OFF ❌'}\n\nUsage:\n.chatbot on\n.chatbot off` }, { quoted: m });
          }
          break;
        }
        case `${prefix}setgeminikey`: case '.setgeminikey': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const key = argText.trim();
          if (!key) { await sock.sendMessage(chatId, { text: `Usage: .setgeminikey <key>\n\nGet a free key at: https://aistudio.google.com/app/apikey\nCurrent key: ${getGeminiKey() ? 'set ✅' : 'not set ❌'}` }, { quoted: m }); return; }
          setGeminiKey(key); await sock.sendMessage(chatId, { text: '✅ Gemini API key set' }, { quoted: m });
          break;
        }

        // === Media commands are PUBLIC (handled above) ===

        default:
          if (cmd.startsWith('.') || cmd.startsWith('!') || cmd.startsWith('/') || (prefix && cmd.startsWith(prefix))) {
            await sock.sendMessage(chatId, { text: `Unknown command: ${cmd}\nType *${prefix}menu* or *${prefix}all* for the list.` }, { quoted: m });
          }
      }
    } catch (e) { console.error('[messages.upsert error]', e.message); }
  });

  // === Anti-delete handler ===
  sock.ev.on('messages.update', async (updates) => {
    try {
      const settings = getSettings();
      for (const update of updates) {
        const chatId = update.key?.remoteJid;
        if (!chatId || !chatId.endsWith('@g.us')) continue;
        const gs = settings[chatId] || {};
        if (!gs.antidelete || gs.antidelete === 'off') continue;
        if (update.update?.message?.protocolMessage?.type === 0) {
          try {
            await sock.sendMessage(chatId, { text: `🚫 *Anti-Delete:* A message was deleted by ${update.key.participant?.split('@')[0] || 'someone'}` });
          } catch (e) { console.log('[ANTIDELETE] error:', e.message); }
        }
      }
    } catch (e) { console.log('[ANTIDELETE] error:', e.message); }
  });
}

// === Helper: anti-action (delete/warn/kick) ===
async function doAntiAction(sock, chatId, m, senderJid, senderNumber, action, type) {
  try {
    const botIsAdmin = await isBotAdmin(sock, chatId);
    if (action === 'delete') {
      try { await sock.sendMessage(chatId, { delete: m.key }); } catch {}
      await sock.sendMessage(chatId, { text: `🚫 @${senderNumber}, ${type}s are not allowed here.`, mentions: [senderJid] });
    } else if (action === 'warn') {
      await sock.sendMessage(chatId, { text: `⚠️ @${senderNumber}, please don't send ${type}s here.`, mentions: [senderJid] });
    } else if (action === 'kick') {
      if (!botIsAdmin) {
        await sock.sendMessage(chatId, { text: `⚠️ Cannot kick — bot is not admin in this group.\nMake the bot admin to use kick action.` });
        return;
      }
      try { await sock.sendMessage(chatId, { delete: m.key }); } catch {}
      await sock.groupParticipantsUpdate(chatId, [senderJid], 'remove');
      await sock.sendMessage(chatId, { text: `🚫 @${senderNumber} was kicked for sending a ${type}.`, mentions: [senderJid] });
    }
    console.log(`[ANTI] ${action} ${type} from ${senderNumber} in ${chatId}`);
  } catch (e) { console.log('[ANTI] error:', e.message); }
}

// === Helper: toggle anti-commands ===
async function toggleAnti(sock, chatId, m, args, key, label) {
  if (!chatId.endsWith('@g.us')) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
  const s = getSettings();
  const gs = s[chatId] || {};
  const sub = args[0]?.toLowerCase();
  if (sub === 'delete' && args[1] === 'on') { gs[key] = 'delete'; s[chatId] = gs; saveSettings(s); await sock.sendMessage(chatId, { text: `✅ Anti-${label} set to DELETE` }, { quoted: m }); }
  else if (sub === 'warn' && args[1] === 'on') { gs[key] = 'warn'; s[chatId] = gs; saveSettings(s); await sock.sendMessage(chatId, { text: `✅ Anti-${label} set to WARN` }, { quoted: m }); }
  else if (sub === 'kick' && args[1] === 'on') { gs[key] = 'kick'; s[chatId] = gs; saveSettings(s); await sock.sendMessage(chatId, { text: `✅ Anti-${label} set to KICK` }, { quoted: m }); }
  else if (sub === 'on') { gs[key] = 'delete'; s[chatId] = gs; saveSettings(s); await sock.sendMessage(chatId, { text: `✅ Anti-${label} ON (default: delete)\nUse: .${key} delete/warn/kick on` }, { quoted: m }); }
  else if (sub === 'off') { gs[key] = 'off'; s[chatId] = gs; saveSettings(s); await sock.sendMessage(chatId, { text: `❌ Anti-${label} OFF` }, { quoted: m }); }
  else { await sock.sendMessage(chatId, { text: `*Anti-${label}:* ${gs[key] || 'off'}\n\nUsage:\n.${key} delete on\n.${key} warn on\n.${key} kick on\n.${key} off` }, { quoted: m }); }
}

// === .sticker command — convert image/video to sticker ===
// Works by sending media with caption .sticker OR replying to media with .sticker
async function handleStickerCommand(sock, chatId, m, msg) {
  let hasMedia = msg.imageMessage || msg.videoMessage || msg.viewOnceMessage?.message?.imageMessage || msg.viewOnceMessage?.message?.videoMessage;
  let targetMsg = m;
  if (!hasMedia) {
    const quoted = msg.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quoted) {
      hasMedia = quoted.imageMessage || quoted.videoMessage || quoted.viewOnceMessage?.message?.imageMessage || quoted.viewOnceMessage?.message?.videoMessage;
      if (hasMedia) {
        targetMsg = {
          key: {
            remoteJid: chatId,
            id: msg.extendedTextMessage.contextInfo.stanzaId,
            participant: msg.extendedTextMessage.contextInfo.participant,
            fromMe: msg.extendedTextMessage.contextInfo.fromMe || false,
          },
          message: quoted,
        };
      }
    }
  }
  if (!hasMedia) { await sock.sendMessage(chatId, { text: 'Send an image/video with caption .sticker, or reply to a media message with .sticker' }, { quoted: m }); return; }
  try {
    const buf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
    await sock.sendMessage(chatId, { sticker: Buffer.from(buf) }, { quoted: m });
  } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
}

// === .url command — uploads media to catbox.moe (permanent, no expiry) ===
// Works in two ways:
//   1. Send media with caption .url
//   2. Reply to a media message with .url
async function handleUrlCommand(sock, chatId, m, msg) {
  // Check if the current message has media
  let hasMedia = msg.imageMessage || msg.videoMessage || msg.audioMessage || msg.documentMessage || msg.stickerMessage ||
                 msg.viewOnceMessage?.message?.imageMessage || msg.viewOnceMessage?.message?.videoMessage;
  let targetMsg = m;

  // If no media on this message, check if it's a reply to a media message
  if (!hasMedia) {
    const quoted = msg.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quoted) {
      hasMedia = quoted.imageMessage || quoted.videoMessage || quoted.audioMessage || quoted.documentMessage || quoted.stickerMessage ||
                 quoted.viewOnceMessage?.message?.imageMessage || quoted.viewOnceMessage?.message?.videoMessage;
      if (hasMedia) {
        targetMsg = {
          key: {
            remoteJid: chatId,
            id: msg.extendedTextMessage.contextInfo.stanzaId,
            participant: msg.extendedTextMessage.contextInfo.participant,
            fromMe: msg.extendedTextMessage.contextInfo.fromMe || false,
          },
          message: quoted,
        };
      }
    }
  }

  if (!hasMedia) {
    await sock.sendMessage(chatId, {
      text: `📎 *Usage:*\n\n1. Send a media file with caption \`${getPrefix() === '' ? '' : getPrefix()}url\`\n2. Reply to a media message with \`${getPrefix() === '' ? '' : getPrefix()}url\`\n\nSupported: image, video, audio, document, sticker`,
    }, { quoted: m });
    return;
  }
  await sock.sendMessage(chatId, { text: '⏳ Uploading...' }, { quoted: m });
  try {
    const buf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
    const buffer = Buffer.from(buf);
    if (!buffer || buffer.length === 0) throw new Error('Empty buffer — could not download media');
    let mime = 'application/octet-stream', ext = 'bin';
    const qm = targetMsg.message;
    if (qm.imageMessage) { mime = qm.imageMessage.mimetype || 'image/jpeg'; ext = 'png'; } // Always PNG for images
    else if (qm.videoMessage) { mime = qm.videoMessage.mimetype || 'video/mp4'; ext = 'mp4'; }
    else if (qm.audioMessage) { mime = qm.audioMessage.mimetype || 'audio/mpeg'; ext = 'mp3'; }
    else if (qm.documentMessage) { mime = qm.documentMessage.mimetype || 'application/octet-stream'; ext = qm.documentMessage.fileName?.split('.').pop() || 'bin'; }
    else if (qm.stickerMessage) { mime = qm.stickerMessage.mimetype || 'image/webp'; ext = 'webp'; }

    // Upload to gofile.io (free, permanent, no expiry, up to unlimited size)
    const FormData = require('form-data');
    const axios = require('axios');
    // 1. Get a server
    const serverRes = await axios.get('https://api.gofile.io/servers', { timeout: 10000 });
    const server = serverRes.data.data.servers[0].name;
    // 2. Upload to that server
    const form = new FormData();
    form.append('file', buffer, `upload.${ext}`);
    const upRes = await axios.post(`https://${server}.gofile.io/contents/uploadfile`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
    });
    if (upRes.data?.status === 'ok' && upRes.data?.data?.downloadPage) {
      const directUrl = upRes.data.data.downloadPage; // e.g. https://gofile.io/d/NijtPcO6
      await sock.sendMessage(chatId, {
        text: `✅ *Media uploaded!*\n\n🔗 *URL:*\n${directUrl}\n\n_Size: ${(buffer.length / 1024).toFixed(1)} KB_\n_Type: ${mime}_\n_Permanent (no expiry)_`,
      }, { quoted: m });
    } else {
      throw new Error('Upload failed: ' + JSON.stringify(upRes.data));
    }
  } catch (e) { await sock.sendMessage(chatId, { text: `❌ Failed: ${e.message}` }, { quoted: m }); }
}

// === Menu builders ===
function buildMenu(pushName) {
  const mem = process.memoryUsage();
  const memMB = (mem.rss / 1024 / 1024).toFixed(0);
  const totalRAM = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  const ramPct = Math.min(100, Math.round((mem.rss / os.totalmem()) * 100));
  const ramBar = '█'.repeat(Math.round(ramPct / 10)) + '░'.repeat(10 - Math.round(ramPct / 10));
  const prefix = getPrefix();
  return `┏▣ ◈ *_SNUGGLE-X_* ◈     
┃ *\`ᴏᴡɴᴇʀ\`* : ${ownerName}
┃ *\`ɴᴜᴍʙᴇʀ\`* : ${ownerNumber}
┃ *\`ᴘʀᴇғɪx\`* : [ ${prefix === '' ? 'no prefix' : prefix} ]
┃ *\`ᴍᴏᴅᴇ\`* : ${getMode()}
┃ *\`ᴜsᴀɢᴇ\`* : ${memMB} MB of ${totalRAM} GB  
┃ *\`ʀᴀᴍ\`*: [${ramBar}] ${ramPct}%
┃ *\`ᴜᴘᴛɪᴍᴇ\`* : ${formatUptime(process.uptime())}
┗▣

> created by yobby king

> Instagram @yobby_mking

\`Command .all to see full command list ✅❤️\``;
}

function buildAllMenu() {
  const prefix = getPrefix();
  const p = prefix === '' ? '' : prefix;
  return `╔════════════════════════════╗
║   ◈ *SNUGGLE X COMMANDS* ◈   ║
║   _Developed by yobby_mking_   ║
╚════════════════════════════╝

╭┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┆ 🌐 *PUBLIC COMMANDS*
┆ ─────────────────────────
┆ ${p}menu ─ Main menu + contact card
┆ ${p}all ─ This full command list
┆ ${p}ping ─ Latency check
┆ ${p}help ─ Quick help
┆ ${p}whoami ─ Your session info
┆ ${p}sticker ─ Image/video → sticker
┆ ${p}url ─ Upload media → get URL
┆
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━

╭┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┆ 👑 *OWNER COMMANDS*
┆ ─────────────────────────
┆ ${p}alive ─ Bot status
┆ ${p}owner ─ Owner info
┆ ${p}mode ─ Show/change mode
┆ ${p}addsudo <num> ─ Add sudo
┆ ${p}delsudo <num> ─ Remove sudo
┆ ${p}sudolist ─ List sudo users
┆ ${p}autofaketyping all on/off
┆ ${p}autofakerecording all on/off
┆ ${p}setmenuimage <url|reply>
┆ ${p}setprefix <prefix|none>
┆ ${p}chatbot on/off ─ AI in DMs
┆
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━

╭┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┆ 👥 *GROUP COMMANDS*
┆ ─────────────────────────
┆ ${p}tagall ─ Tag all members
┆ ${p}hidetag <text> ─ Silent tag
┆ ${p}promote @user ─ Make admin
┆ ${p}demote @user ─ Remove admin
┆ ${p}kick @user ─ Remove member
┆ ${p}add <number> ─ Add member
┆
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━

╭┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┆ 🛡 *ANTI COMMANDS*
┆ ─────────────────────────
┆ ${p}antilink delete/warn/kick on
┆ ${p}antispam delete/warn/kick on
┆ ${p}antibadword delete/warn/kick on
┆ ${p}antidelete on/off
┆ ${p}antimention delete/warn/kick on
┆ ${p}antitag delete/warn/kick on
┆ ${p}antisticker delete/warn/kick on
┆ ─ Use "off" to disable any
┆
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━

╭┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┆ 🎨 *MEDIA COMMANDS*
┆ ─────────────────────────
┆ ${p}sticker ─ Convert media to sticker
┆ ${p}url ─ Upload media, get public URL
┆ ${p}song <query> ─ Download MP3
┆ ${p}video <query> ─ Download MP4
┆
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━

╭┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┆ 🔒 *OWNER-ONLY*
┆ ─────────────────────────
┆ ${p}vv ─ Unlock view-once (reply)
┆ ${p}setmenuimage <url|reply>
┆ ${p}setmenuvideo <url|reply>
┆ ${p}setprefix <prefix|none>
┆ ${p}chatbot on/off ─ AI in DMs
┆
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━

> *SNUGGLE X* · Created by Yobby King
> Instagram: @yobby_mking
> Dev: 0795314221 / 0181163563`;
}

function buildAlive() {
  const mem = process.memoryUsage();
  return `*SNUGGLE X IS ALIVE ✅*
> snuggle x bot
> status: online 🟢
> owner: ${ownerName}
> number: ${ownerNumber}
> mode: ${getMode()}
> prefix: ${getPrefix() === '' ? 'none' : getPrefix()}
> uptime: ${formatUptime(process.uptime())}
> memory: ${(mem.rss / 1024 / 1024).toFixed(0)} MB`;
}

function buildOwner() {
  return `*BOT OWNER* 👑
> Name: Yobby King
> Number: ${ownerNumber}
> Instagram: @yobby_mking
> Dev: 0795314221 / 0181163563`;
}

function formatUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

start().catch(console.error);
