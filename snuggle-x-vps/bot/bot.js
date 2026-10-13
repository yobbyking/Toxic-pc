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
const warnCount = new Map(); // senderJid -> count (for antilink warn)

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
      // Allow fromMe=true in groups — since the bot is the owner's linked device,
      // fromMe=true in a group means the OWNER sent the message.
      // Only skip fromMe=true in DMs to non-owner (to avoid echo loops).
      if (m.key.fromMe && !isSelfChat && !isGroup) return;

      let senderJid = isGroup ? participant : chatId;
      const senderNumber = senderJid ? senderJid.split(':')[0].split('@')[0] : '';
      const pushName = m.pushName || (isSelfChat ? 'You' : 'User');
      // For group messages with fromMe=true, the owner sent it (bot is owner's linked device)
      const ownerCheck = isOwner(senderJid, participantPn) || isSelfChat || (isGroup && m.key.fromMe);
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
      // Some group messages arrive wrapped in senderKeyDistributionMessage
      else if (msg.senderKeyDistributionMessage?.groupRegistrationMessage?.groupParticipant?.senderKeyDistributionMessage) {
        // nested — skip
      }
      // Try to extract from nested message structures
      if (!text) {
        // Check if there's text inside the message somewhere
        const msgStr = JSON.stringify(msg);
        if (msgStr.includes('"conversation"')) {
          try { text = msg.conversation || ''; } catch {}
        }
      }
      if (!text) return;

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
          // Anti-mention (detects @mentions and status tags)
          if (gs.antimention && gs.antimention !== 'off') {
            const hasMention = (msg.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) || /@\d+/.test(raw) || raw.toLowerCase().includes('@status') || raw.toLowerCase().includes('@broadcast') || raw.toLowerCase().includes('status@');
            if (hasMention) {
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
      if ((mode === 'silent' || mode === 'private') && !ownerCheck && !sudoCheck) return;
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

      // === Small delay before responding in DMs (prevents "Waiting for this message") ===
      if (!isGroup) { await new Promise(r => setTimeout(r, 1000)); }

      // === PUBLIC commands (work for everyone) ===
      if (cmd === `${prefix}menu` || (prefix && lower === 'menu')) {
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
      if (cmd === `${prefix}all` || (prefix && lower === 'all')) {
        await sock.sendMessage(chatId, { text: buildAllMenu() }, { quoted: m });
        return;
      }
      if (cmd === `${prefix}ping`) {
        const t = Date.now();
        await sock.sendMessage(chatId, { text: `*PONG* 🏓\nLatency: ${Date.now() - t}ms` }, { quoted: m });
        return;
      }
      if (cmd === `${prefix}help`) {
        await sock.sendMessage(chatId, { text: `Type *${prefix}menu* for the menu, or *${prefix}all* for the full command list.` }, { quoted: m });
        return;
      }
      if (cmd === `${prefix}whoami`) {
        await sock.sendMessage(chatId, { text: `*You are* ${pushName}\n*Number:* ${senderNumber}\n*Status:* ${ownerCheck ? 'Owner 👑' : sudoCheck ? 'Sudo 🔑' : 'User'}` }, { quoted: m });
        return;
      }
      // Sticker and URL are PUBLIC — anyone can use them
      if (cmd === `${prefix}sticker`) {
        await handleStickerCommand(sock, chatId, m, msg);
        return;
      }
      if (cmd === `${prefix}url`) {
        await handleUrlCommand(sock, chatId, m, msg);
        return;
      }

      // === ACCESS GATE — owner/sudo only beyond this point ===
      if (!ownerCheck && !sudoCheck) {
        if (mode === 'private' || mode === 'silent') {
          await sock.sendMessage(chatId, { text: '> *only sudo access 🚫*\n> Get yours 0181163563 ✅' }, { quoted: m });
          return;
        }
        const ownerOnlyCmds = ['alive','owner','mode','addsudo','delsudo','sudolist','tagall','hidetag','promote','demote','kick','add','antilink','antispam','antibadword','antidelete','antimention','antitag','antisticker','autofaketyping','autofakerecording','setmenuimage','setmenuvideo','setprefix','chatbot','setgeminikey','vv','fak','kickadmins','kickall','getpp','pair','block','unblock','setpp','setbio','setname','leave','join','resetlink','setgroupname','setdesc'];
        if (ownerOnlyCmds.some(c => cmd === `${prefix}${c}`)) {
          await sock.sendMessage(chatId, { text: '> *only sudo access 🚫*\n> Get yours 0181163563 ✅' }, { quoted: m });
          return;
        }
        if (prefix && cmd.startsWith(prefix)) {
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
          // Admin check: since bot is owner's linked device, if owner is admin, bot is admin
          const botIsAdmin = await isBotAdmin(sock, chatId);
          const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!target) { await sock.sendMessage(chatId, { text: 'Mention a user' }, { quoted: m }); return; }
          try { await sock.groupParticipantsUpdate(chatId, [target], 'promote'); await sock.sendMessage(chatId, { text: `✅ Promoted @${target.split('@')[0]}`, mentions: [target] }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}demote`: case '.demote': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          // Admin check: since bot is owner's linked device, if owner is admin, bot is admin
          const botIsAdmin = await isBotAdmin(sock, chatId);
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
          // Admin check: since bot is owner's linked device, if owner is admin, bot is admin
          const botIsAdmin = await isBotAdmin(sock, chatId);
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
        case `${prefix}antidelete`: case '.antidelete': {
          if (argText === 'all on') {
            const s = getSettings(); s.global_antidelete = true; saveSettings(s);
            await sock.sendMessage(chatId, { text: '✅ Anti-delete ON (ALL chats) — deleted messages sent to your DM' }, { quoted: m });
          } else if (argText === 'all off') {
            const s = getSettings(); s.global_antidelete = false; saveSettings(s);
            await sock.sendMessage(chatId, { text: '❌ Anti-delete OFF (all chats)' }, { quoted: m });
          } else {
            await toggleAnti(sock, chatId, m, args, 'antidelete', 'delete');
          }
          break;
        }
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

        // === Clear menu video (switch back to image/text) ===
        case `${prefix}clearmenuvideo`: case '.clearmenuvideo': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          try { fs.unlinkSync(menuVideoFile); } catch {}
          menuVideoBuffer = null;
          await sock.sendMessage(chatId, { text: '✅ Menu video cleared. Now using menu image (if set).' }, { quoted: m });
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

        // === .fak — remove from voice chat (kicks from group, which also removes from VC) ===
        case `${prefix}fak`: {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!target) { await sock.sendMessage(chatId, { text: '⚠️ Reply to a user or mention them with .fak\n\nNote: This removes them from the group entirely (WhatsApp does not allow removing only from voice chat via API). They can rejoin with the group link.' }, { quoted: m }); return; }
          try {
            await sock.groupParticipantsUpdate(chatId, [target], 'remove');
            await sock.sendMessage(chatId, { text: `✅ @${target.split('@')[0]} removed from group + voice chat`, mentions: [target] }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `❌ Failed: ${e.message}\n\nNote: WhatsApp does not have an API to remove only from voice chat. .fak removes from the group entirely.` }, { quoted: m }); }
          break;
        }

        // === .kickadmins — kick all admins (except owner) ===
        case `${prefix}kickadmins`: {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          try {
            const meta = await sock.groupMetadata(chatId);
            const admins = meta.participants.filter(p => (p.admin === 'admin' || p.admin === 'superadmin') && p.id !== sock.user.id);
            if (admins.length === 0) { await sock.sendMessage(chatId, { text: 'No admins to kick' }, { quoted: m }); return; }
            await sock.sendMessage(chatId, { text: `⏳ Kicking ${admins.length} admins...` }, { quoted: m });
            for (const admin of admins) {
              try { await sock.groupParticipantsUpdate(chatId, [admin.id], 'remove'); }
              catch (e) { console.log(`[KICKADMINS] Failed to kick ${admin.id}: ${e.message}`); }
            }
            await sock.sendMessage(chatId, { text: `✅ Kicked ${admins.length} admins` }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }

        // === .kickall — kick all members (except owner) ===
        case `${prefix}kickall`: {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          try {
            const meta = await sock.groupMetadata(chatId);
            const members = meta.participants.filter(p => p.id !== sock.user.id);
            if (members.length === 0) { await sock.sendMessage(chatId, { text: 'No members to kick' }, { quoted: m }); return; }
            await sock.sendMessage(chatId, { text: `⏳ Kicking ${members.length} members...` }, { quoted: m });
            let kicked = 0;
            for (const member of members) {
              try { await sock.groupParticipantsUpdate(chatId, [member.id], 'remove'); kicked++; }
              catch (e) { console.log(`[KICKALL] Failed: ${e.message}`); }
              // Small delay to avoid rate limit
              await new Promise(r => setTimeout(r, 500));
            }
            await sock.sendMessage(chatId, { text: `✅ Kicked ${kicked}/${members.length} members` }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }

        // === .getpp — get profile pic of replied user ===
        case `${prefix}getpp`: {
          const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                         m.message.extendedTextMessage?.contextInfo?.participant ||
                         (isGroup ? m.key.participant : chatId);
          if (!target) { await sock.sendMessage(chatId, { text: 'Reply to a user or mention them' }, { quoted: m }); return; }
          try {
            const ppUrl = await sock.profilePictureUrl(target, 'image');
            const axios = require('axios');
            const res = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 15000 });
            const name = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ? 'Mentioned user' : (m.pushName || 'User');
            await sock.sendMessage(chatId, {
              image: Buffer.from(res.data),
              caption: `📸 *Profile picture of ${name}*
_${target.split('@')[0]}_`,
            }, { quoted: m });
          } catch (e) {
            // Profile pic might be private — try to get a low-quality version
            try {
              const ppUrl = await sock.profilePictureUrl(target, 'image');
              await sock.sendMessage(chatId, { text: `Profile pic URL: ${ppUrl}` }, { quoted: m });
            } catch {
              await sock.sendMessage(chatId, { text: `❌ Could not get profile picture (may be private)` }, { quoted: m });
            }
          }
          break;
        }

        // === Fun & Utility commands ===
        case `${prefix}weather`: {
          const city = argText;
          if (!city) { await sock.sendMessage(chatId, { text: 'Usage: .weather <city>' }, { quoted: m }); return; }
          try {
            const axios = require('axios');
            const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=3`, { timeout: 10000 });
            await sock.sendMessage(chatId, { text: `🌤️ *Weather:* ${res.data}` }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `❌ Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}wiki`: {
          const query = argText;
          if (!query) { await sock.sendMessage(chatId, { text: 'Usage: .wiki <query>' }, { quoted: m }); return; }
          try {
            const axios = require('axios');
            const res = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, { timeout: 10000 });
            const d = res.data;
            await sock.sendMessage(chatId, { text: `📖 *${d.title}*\n\n${d.extract}\n\n🔗 ${d.content_urls?.desktop?.page || ''}` }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `❌ Not found` }, { quoted: m }); }
          break;
        }
        case `${prefix}define`: {
          const word = argText;
          if (!word) { await sock.sendMessage(chatId, { text: 'Usage: .define <word>' }, { quoted: m }); return; }
          try {
            const axios = require('axios');
            const res = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { timeout: 10000 });
            const d = res.data[0];
            const def = d.meanings[0].definitions[0];
            await sock.sendMessage(chatId, { text: `📖 *${word}* (${d.meanings[0].partOfSpeech})\n\n${def.definition}${def.example ? '\n\n_Example: ' + def.example + '_' : ''}` }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `❌ Word not found` }, { quoted: m }); }
          break;
        }
        case `${prefix}shorten`: {
          const url = args[0];
          if (!url) { await sock.sendMessage(chatId, { text: 'Usage: .shorten <url>' }, { quoted: m }); return; }
          try {
            const axios = require('axios');
            const res = await axios.get(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { timeout: 10000 });
            await sock.sendMessage(chatId, { text: `🔗 *Shortened:* ${res.data}` }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `❌ Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}tts`: {
          const text = argText;
          if (!text) { await sock.sendMessage(chatId, { text: 'Usage: .tts <text>' }, { quoted: m }); return; }
          try {
            const axios = require('axios');
            const res = await axios.get(`https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`, { responseType: 'arraybuffer', timeout: 15000 });
            await sock.sendMessage(chatId, { audio: Buffer.from(res.data), mimetype: 'audio/mpeg' }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `❌ Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}translate`: {
          if (!argText) { await sock.sendMessage(chatId, { text: 'Usage: .translate <text>' }, { quoted: m }); return; }
          try {
            const axios = require('axios');
            const res = await axios.get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(argText)}`, { timeout: 10000 });
            const translated = res.data[0].map(t => t[0]).join('');
            await sock.sendMessage(chatId, { text: `🌐 *Translation:*\n${translated}` }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `❌ Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}8ball`: {
          const answers = ['It is certain.', 'Without a doubt.', 'Yes definitely.', 'You may rely on it.', 'Most likely.', 'Yes.', 'Signs point to yes.', 'Ask again later.', 'Better not tell you now.', 'Cannot predict now.', 'Dont count on it.', 'My reply is no.', 'Very doubtful.'];
          const ans = answers[Math.floor(Math.random() * answers.length)];
          await sock.sendMessage(chatId, { text: `🎱 *Magic 8-Ball*\n\n${ans}` }, { quoted: m });
          break;
        }
        case `${prefix}truth`: {
          const truths = ['What is your biggest fear?', 'What is the most embarrassing thing that happened to you?', 'What is your biggest secret?', 'Who is your crush?', 'What is the worst thing you have ever done?', 'What is your biggest regret?', 'What is the strangest thing you have ever eaten?', 'What is the biggest lie you have ever told?'];
          await sock.sendMessage(chatId, { text: `🤔 *Truth:* ${truths[Math.floor(Math.random() * truths.length)]}` }, { quoted: m });
          break;
        }
        case `${prefix}dare`: {
          const dares = ['Send a voice note singing a song.', 'Send your last screenshot.', 'Send a selfie right now.', 'Text the first person in your contacts "I love you".', 'Do 10 push-ups and send a video.', 'Change your profile picture to a cartoon character for 1 hour.'];
          await sock.sendMessage(chatId, { text: `😈 *Dare:* ${dares[Math.floor(Math.random() * dares.length)]}` }, { quoted: m });
          break;
        }
        case `${prefix}joke`: {
          try {
            const axios = require('axios');
            const res = await axios.get('https://v2.jokeapi.dev/joke/Any?safe-mode&type=single', { timeout: 10000 });
            await sock.sendMessage(chatId, { text: `😂 ${res.data.joke}` }, { quoted: m });
          } catch { await sock.sendMessage(chatId, { text: '😂 Why dont programmers like nature? It has too many bugs.' }, { quoted: m }); }
          break;
        }
        case `${prefix}quote`: {
          try {
            const axios = require('axios');
            const res = await axios.get('https://api.quotable.io/random', { timeout: 10000 });
            await sock.sendMessage(chatId, { text: `💬 *${res.data.content}*\n\n— ${res.data.author}` }, { quoted: m });
          } catch { await sock.sendMessage(chatId, { text: '💬 *The only way to do great work is to love what you do.*\n\n— Steve Jobs' }, { quoted: m }); }
          break;
        }
        case `${prefix}fact`: {
          const facts = ['Honey never spoils.', 'A group of flamingos is called a flamboyance.', 'The shortest war in history lasted 38 minutes.', 'Octopuses have three hearts.', 'A jiffy is an actual unit of time (1/100 of a second).', 'Bananas are berries, but strawberries arent.', 'The first computer bug was an actual bug.'];
          await sock.sendMessage(chatId, { text: `🧠 *Did you know?* ${facts[Math.floor(Math.random() * facts.length)]}` }, { quoted: m });
          break;
        }
        case `${prefix}pickupline`: {
          const lines = ['Are you a magician? Because every time I look at you, everyone else disappears.', 'Do you have a map? I keep getting lost in your eyes.', 'Are you Wi-Fi? Because Im feeling a connection.', 'Is your name Google? Because you have everything Ive been searching for.'];
          await sock.sendMessage(chatId, { text: `😏 ${lines[Math.floor(Math.random() * lines.length)]}` }, { quoted: m });
          break;
        }
        case `${prefix}rps`: {
          const choices = ['rock', 'paper', 'scissors'];
          const botChoice = choices[Math.floor(Math.random() * 3)];
          const userChoice = args[0]?.toLowerCase();
          if (!userChoice || !choices.includes(userChoice)) { await sock.sendMessage(chatId, { text: 'Usage: .rps <rock|paper|scissors>' }, { quoted: m }); return; }
          let result = '';
          if (userChoice === botChoice) result = 'Tie! 🤝';
          else if ((userChoice === 'rock' && botChoice === 'scissors') || (userChoice === 'paper' && botChoice === 'rock') || (userChoice === 'scissors' && botChoice === 'paper')) result = 'You win! 🎉';
          else result = 'I win! 🤖';
          await sock.sendMessage(chatId, { text: `🪨📄✂️ *Rock Paper Scissors*\n\nYou: ${userChoice}\nBot: ${botChoice}\n\n${result}` }, { quoted: m });
          break;
        }
        case `${prefix}ship`: {
          const user1 = args[0] || 'Romeo';
          const user2 = args[1] || 'Juliet';
          const percent = Math.floor(Math.random() * 100);
          const emoji = percent > 80 ? '💕' : percent > 50 ? '💖' : percent > 30 ? '💔' : '❌';
          await sock.sendMessage(chatId, { text: `💞 *Ship*\n\n${user1} ❤️ ${user2}\n\nCompatibility: ${percent}% ${emoji}` }, { quoted: m });
          break;
        }
        case `${prefix}time`: {
          await sock.sendMessage(chatId, { text: `🕐 ${new Date().toLocaleString()}` }, { quoted: m });
          break;
        }
        case `${prefix}uptime`: {
          await sock.sendMessage(chatId, { text: `⏱️ Bot uptime: ${formatUptime(process.uptime())}` }, { quoted: m });
          break;
        }
        case `${prefix}repo`: {
          await sock.sendMessage(chatId, { text: `📦 GitHub: https://github.com/yobbyking/snuggle-x-vps` }, { quoted: m });
          break;
        }
        case `${prefix}block`: {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
          if (!target) { await sock.sendMessage(chatId, { text: 'Mention a user to block' }, { quoted: m }); return; }
          try { await sock.updateBlockStatus(target, 'block'); await sock.sendMessage(chatId, { text: `✅ Blocked ${target.split('@')[0]}` }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}unblock`: {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const target = args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
          if (!target) { await sock.sendMessage(chatId, { text: 'Usage: .unblock <number>' }, { quoted: m }); return; }
          try { await sock.updateBlockStatus(target, 'unblock'); await sock.sendMessage(chatId, { text: `✅ Unblocked ${target.split('@')[0]}` }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}setpp`: case `${prefix}setprofilepic`: {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          try {
            if (msg.imageMessage) {
              const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: P({ level: 'silent' }) });
              await sock.updateProfilePicture(sock.user.id, Buffer.from(buf));
              await sock.sendMessage(chatId, { text: '✅ Profile picture updated' }, { quoted: m });
            } else { await sock.sendMessage(chatId, { text: 'Send an image with caption .setpp' }, { quoted: m }); }
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}setbio`: {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const bio = argText;
          if (!bio) { await sock.sendMessage(chatId, { text: 'Usage: .setbio <text>' }, { quoted: m }); return; }
          try { await sock.updateProfileStatus(bio); await sock.sendMessage(chatId, { text: '✅ Bio updated' }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}setname`: {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const name = argText;
          if (!name) { await sock.sendMessage(chatId, { text: 'Usage: .setname <name>' }, { quoted: m }); return; }
          try { await sock.updateProfileName(name); await sock.sendMessage(chatId, { text: `✅ Name updated to: ${name}` }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}grouplink`: case `${prefix}link`: {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          try {
            const code = await sock.groupInviteCode(chatId);
            await sock.sendMessage(chatId, { text: `🔗 *Group Link:*\nhttps://chat.whatsapp.com/${code}` }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}resetlink`: {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          try { await sock.groupRevokeInvite(chatId); await sock.sendMessage(chatId, { text: '✅ Group link reset' }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}setgroupname`: {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          const name = argText;
          if (!name) { await sock.sendMessage(chatId, { text: 'Usage: .setgroupname <name>' }, { quoted: m }); return; }
          try { await sock.groupUpdateSubject(chatId, name); await sock.sendMessage(chatId, { text: `✅ Group name updated to: ${name}` }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}setdesc`: {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          const desc = argText;
          if (!desc) { await sock.sendMessage(chatId, { text: 'Usage: .setdesc <description>' }, { quoted: m }); return; }
          try { await sock.groupUpdateDescription(chatId, desc); await sock.sendMessage(chatId, { text: '✅ Group description updated' }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}ginfo`: {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          try {
            const meta = await sock.groupMetadata(chatId);
            const admins = meta.participants.filter(p => p.admin).length;
            await sock.sendMessage(chatId, { text: `📋 *Group Info*\n\n*Name:* ${meta.subject}\n*Members:* ${meta.participants.length}\n*Admins:* ${admins}\n*Created:* ${new Date(meta.creation * 1000).toLocaleDateString()}\n*Desc:* ${meta.desc || 'None'}` }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case `${prefix}leave`: {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          await sock.sendMessage(chatId, { text: '👋 Goodbye!' }, { quoted: m });
          await sock.groupLeave(chatId);
          break;
        }
        case `${prefix}join`: {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const link = args[0];
          if (!link || !link.includes('chat.whatsapp.com')) { await sock.sendMessage(chatId, { text: 'Usage: .join <group link>' }, { quoted: m }); return; }
          const code = link.split('/').pop();
          try { await sock.groupAcceptInvite(code); await sock.sendMessage(chatId, { text: '✅ Joined group' }, { quoted: m }); }
          catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }

        // === .pair — pair for a friend remotely ===
        case `${prefix}pair`: case '.pair': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const pairNum = args[0]?.replace(/[^0-9]/g, '');
          if (!pairNum || pairNum.length < 10) { await sock.sendMessage(chatId, { text: 'Usage: .pair <number with country code>\nExample: .pair 254712345678' }, { quoted: m }); return; }
          await sock.sendMessage(chatId, { text: `⏳ Requesting pairing code for +${pairNum}...` }, { quoted: m });
          try {
            // Create a new Baileys socket for pairing
            const { useMultiFileAuthState: useAuth, makeWASocket: makeSock, fetchLatestBaileysVersion: fetchVer, makeCacheableSignalKeyStore: makeKeys, Browsers: B } = require('@whiskeysockets/baileys');
            const pairSessionDir = path.join(sessionDir, 'pair-' + pairNum);
            fs.rmSync(pairSessionDir, { recursive: true, force: true });
            fs.mkdirSync(pairSessionDir, { recursive: true });
            const { state: pairState, saveCreds: pairSave } = await useAuth(pairSessionDir);
            const { version: pairVer } = await fetchVer();
            const pairLogger = P({ level: 'silent' });
            const pairSock = makeSock({
              version: pairVer,
              auth: { creds: pairState.creds, keys: makeKeys(pairState.keys, pairLogger) },
              printQRInTerminal: false,
              browser: B.ubuntu('Chrome'),
              logger: pairLogger,
              markOnlineOnConnect: false,
            });
            let pairCode = null;
            let pairLinked = false;
            pairSock.ev.on('creds.update', pairSave);
            pairSock.ev.on('connection.update', async (upd) => {
              if (upd.qr && !pairCode) {
                setTimeout(async () => {
                  try { pairCode = await pairSock.requestPairingCode(pairNum); }
                  catch (e) { console.log('[PAIR] requestPairingCode failed:', e.message); }
                }, 3000);
              }
              if (upd.connection === 'open' && !pairLinked) {
                pairLinked = true;
                const friendJid = pairSock.user.id;
                const friendNum = friendJid.split(':')[0].split('@')[0];
                // Upload session to VPS + get short ID
                const axios = require('axios');
                const FormData = require('form-data');
                const zlib = require('zlib');
                // Read all session files
                const files = {};
                function scan(d, base = '') {
                  for (const n of fs.readdirSync(d)) {
                    const fp = path.join(d, n);
                    if (fs.statSync(fp).isDirectory()) scan(fp, base + n + '/');
                    else files[base + n] = fs.readFileSync(fp).toString('base64');
                  }
                }
                scan(pairSessionDir);
                const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify(files)));
                const loginRes = await axios.post('http://localhost:2002/api/login', { password: 'yobby1' });
                const storeRes = await axios.post('http://localhost:2002/api/session/store',
                  { session: gzipped.toString('base64') },
                  { headers: { 'x-admin-token': loginRes.data.token } });
                const shortId = storeRes.data.shortId;
                await sock.sendMessage(chatId, { text: `✅ *Paired successfully!*\n\nFriend: +${friendNum}\nSession ID: \`yobbyx:~${shortId}\`\n\nTell them to send this session ID to the admin dashboard to deploy their bot.` }, { quoted: m });
                setTimeout(() => { try { pairSock.end(); } catch {} fs.rmSync(pairSessionDir, { recursive: true, force: true }); }, 5000);
              }
              if (upd.connection === 'close') {
                if (!pairLinked && !pairCode) {
                  // Connection closed before pairing
                }
              }
            });
          } catch (e) { await sock.sendMessage(chatId, { text: `❌ Pair failed: ${e.message}` }, { quoted: m }); }
          break;
        }

        // === Media commands are PUBLIC (handled above) ===

        default:
          if (prefix && cmd.startsWith(prefix)) {
            await sock.sendMessage(chatId, { text: `Unknown command: ${cmd}\nType *${prefix}menu* or *${prefix}all* for the list.` }, { quoted: m });
          }
      }
    } catch (e) { console.error('[messages.upsert error]', e.message); }
  });

  // === Anti-call handler ===
  sock.ev.on('call', async (calls) => {
    try {
      const s = getSettings();
      if (!s.anticall) return;
      for (const call of calls) {
        await sock.rejectCall(call.id, call.from);
        console.log('[ANTICALL] Rejected call from ' + call.from);
      }
    } catch (e) { console.log('[ANTICALL] error:', e.message); }
  });

  // === Anti-delete handler — send deleted messages to owner DM ===
  sock.ev.on('messages.update', async (updates) => {
    try {
      const settings = getSettings();
      for (const update of updates) {
        const chatId = update.key?.remoteJid;
        if (!chatId) continue;
        // Check if antidelete is on for this group OR globally
        const gs = settings[chatId] || {};
        const globalAntidelete = settings.global_antidelete === true;
        if (!gs.antidelete && !globalAntidelete) continue;
        if (gs.antidelete === 'off' && !globalAntidelete) continue;
        // Check if message was deleted
        const protocolMsg = update.update?.message?.protocolMessage;
        if (protocolMsg?.type === 0 || update.update?.status === 'deleted' || (protocolMsg && protocolMsg.type === 0)) {
          const deletedKey = update.key;
          const deleter = deletedKey.participant || deletedKey.remoteJid || 'unknown';
          const deleterNum = deleter.split('@')[0].split(':')[0];
          try {
            // Try to get the original message from the store
            let origMsg = null;
            try { origMsg = await sock.loadMessage?.(chatId, deletedKey.id); } catch {}
            // Build notification
            const chatType = chatId.endsWith('@g.us') ? 'Group' : 'DM';
            const chatName = chatId.split('@')[0];
            let notification = `🚫 *ANTI-DELETE*\n\n`;
            notification += `> Chat: ${chatType} (${chatName})\n`;
            notification += `> Deleted by: ${deleterNum}\n`;
            notification += `> Time: ${new Date().toLocaleString()}\n`;
            // Send to owner's DM
            await sock.sendMessage(ownerJid, { text: notification });
            // If we have the original message, forward it
            if (origMsg && origMsg.message) {
              try { await sock.sendMessage(ownerJid, { forward: origMsg }); }
              catch { /* forward failed, at least notification was sent */ }
            } else {
              await sock.sendMessage(ownerJid, { text: `_Original message not available in store_` });
            }
            console.log(`[ANTIDELETE] ${deleterNum} deleted a message in ${chatId}`);
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
      // Try kick regardless — if bot isn't admin, WhatsApp will return error
      if (!botIsAdmin) console.log('[ANTI] Bot is not admin, kick may fail');
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

    // Upload to tmpfiles.org (direct download link with file extension)
    const FormData = require('form-data');
    const axios = require('axios');
    const form = new FormData();
    form.append('file', buffer, `upload.${ext}`);
    const upRes = await axios.post('https://tmpfiles.org/api/v1/upload', form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 60000,
    });
    if (upRes.data?.data?.url) {
      // Convert to direct download link (https://tmpfiles.org/dl/xxxx/filename.ext)
      const directUrl = upRes.data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
      await sock.sendMessage(chatId, {
        text: `✅ *Media uploaded!*\n\n🔗 *URL:*\n${directUrl}\n\n_Size: ${(buffer.length / 1024).toFixed(1)} KB_\n_Type: ${mime}_`,
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
  const ramBarLen = 10;
  const ramFilled = Math.round((ramPct / 100) * ramBarLen);
  const ramBar = '█'.repeat(ramFilled) + '░'.repeat(ramBarLen - ramFilled);
  const prefix = getPrefix();
  const speed = (process.hrtime()[1] / 1e6).toFixed(4);
  const version = '1.8.5';
  const pluginCount = 70;
  const host = 'Railway VPS';
  return `┏▣ ◈ *\`®•SNUGGLE •X\`* ◈
┃ *ᴏᴡɴᴇʀ* : ${ownerName}
┃ *ᴘʀᴇғɪx* : [ ${prefix === '' ? 'None' : prefix} ]
┃ *ʜᴏsᴛ* : ${host}
┃ *ᴘʟᴜɢɪɴs* : ${pluginCount}
┃ *ᴍᴏᴅᴇ* : ${getMode()}
┃ *ᴠᴇʀsɪᴏɴ* : ${version}
┃ *sᴘᴇᴇᴅ* : ${speed} ms
┃ *ᴜsᴀɢᴇ* : ${memMB} MB of ${totalRAM} GB
┃ *ʀᴀᴍ:* [${ramBar}] ${ramPct}%
┃ *ᴜᴘᴛɪᴍᴇ* : ${formatUptime(process.uptime())}
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
┆ 👥 *GROUP & ANTI COMMANDS*
┆ ─────────────────────────
┆ ${p}tagall ─ Tag all members
┆ ${p}hidetag <text> ─ Silent tag
┆ ${p}promote @user ─ Make admin
┆ ${p}demote @user ─ Remove admin
┆ ${p}kick @user ─ Remove member
┆ ${p}add <number> ─ Add member
┆ ${p}kickall ─ Kick ALL members
┆ ${p}kickadmins ─ Kick all admins
┆ ${p}fak @user ─ Remove from VC
┆ ${p}getpp ─ Get profile pic
┆ ${p}pair <number> ─ Pair for friend
┆ ─
┆ ${p}antilink delete/warn/kick on
┆ ${p}antispam delete/warn/kick on
┆ ${p}antibadword delete/warn/kick on
┆ ${p}antidelete on/off (all on/off)
┆ ${p}antimention delete/warn/kick on
┆ ${p}antitag delete/warn/kick on
┆ ${p}antisticker delete/warn/kick on
┆ ─ Use "off" to disable any
┆
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━

╭┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┆ 🎨 *MEDIA & DOWNLOAD*
┆ ─────────────────────────
┆ ${p}sticker ─ Convert media to sticker
┆ ${p}url ─ Upload media, get URL
┆ ${p}song <query> ─ Download MP3
┆ ${p}video <query> ─ Download MP4
┆ ${p}tts <text> ─ Text to speech
┆ ${p}translate <text> ─ Translate
┆
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━

╭┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┆ 🎮 *FUN & GAMES*
┆ ─────────────────────────
┆ ${p}8ball <question> ─ Magic 8-ball
┆ ${p}truth ─ Truth question
┆ ${p}dare ─ Dare challenge
┆ ${p}joke ─ Random joke
┆ ${p}quote ─ Random quote
┆ ${p}fact ─ Random fact
┆ ${p}pickupline ─ Pickup line
┆ ${p}rps <rock|paper|scissors>
┆ ${p}ship <name1> <name2>
┆
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━

╭┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┆ 🔍 *SEARCH & TOOLS*
┆ ─────────────────────────
┆ ${p}weather <city>
┆ ${p}wiki <query>
┆ ${p}define <word>
┆ ${p}shorten <url>
┆ ${p}time ─ Current time
┆ ${p}uptime ─ Bot uptime
┆ ${p}repo ─ GitHub repo
┆
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━

╭┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┆ 🔒 *OWNER-ONLY*
┆ ─────────────────────────
┆ ${p}vv ─ Unlock view-once (reply)
┆ ${p}setmenuimage <url|reply>
┆ ${p}setmenuvideo <url|reply>
┆ ${p}clearmenuvideo ─ Back to image
┆ ${p}setprefix <prefix|none>
┆ ${p}chatbot on/off ─ AI in DMs
┆ ${p}fak @user ─ Remove from VC
┆ ${p}kickall ─ Kick all members
┆ ${p}kickadmins ─ Kick all admins
┆ ${p}getpp ─ Get profile pic
┆ ${p}pair <number> ─ Pair for friend
┆ ${p}block/unblock <number>
┆ ${p}setpp ─ Set profile pic
┆ ${p}setbio ─ Set bio
┆ ${p}setname ─ Set name
┆ ${p}join <link> ─ Join group
┆ ${p}leave ─ Leave group
┆ ${p}grouplink ─ Get group link
┆ ${p}resetlink ─ Reset group link
┆ ${p}setgroupname ─ Set group name
┆ ${p}setdesc ─ Set group desc
┆ ${p}ginfo ─ Group info
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
