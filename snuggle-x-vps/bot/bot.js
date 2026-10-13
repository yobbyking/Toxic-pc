// Snuggle X Bot — runs as a pm2 process per user.
// Usage: node bot.js <sessionFolder>
//
// Features (ported from KLAUS MD):
//   - LID-aware owner detection (with participantPn + async LID resolution)
//   - Three-tier access: Owner / Sudo / User
//   - BOT_MODE: public / silent / groups / dms
//   - Group anti-commands: antilink, antispam, antibadword, antidelete
//   - Group commands: tagall, hidetag, promote, demote, kick, mute, unmute
//   - .url uploads media to tmpfiles.org
//   - No vCard contact card (just text menu)

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

// Read owner from creds.json
let ownerJid = null;
let ownerName = 'Not Set!';
const credsFile = path.join(sessionDir, 'creds.json');
if (fs.existsSync(credsFile)) {
  try {
    const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
    if (creds.me && creds.me.id) {
      ownerJid = creds.me.id;
      ownerName = creds.me.name || 'Not Set!';
    }
  } catch {}
}
const ownerNumber = ownerJid ? ownerJid.split(':')[0].split('@')[0] : null;
console.log(`[Snuggle X Bot] Owner: ${ownerNumber} (${ownerJid})`);
console.log(`[Snuggle X Bot] Session dir: ${sessionDir}`);

// === Mode + sudo + settings files ===
const modeFile = path.join(sessionDir, 'mode.txt');
const sudoFile = path.join(sessionDir, 'sudos.txt');
const settingsFile = path.join(sessionDir, 'settings.json');

function getMode() {
  try { return fs.readFileSync(modeFile, 'utf-8').trim() || 'public'; }
  catch { return 'public'; }
}
function setMode(m) { fs.writeFileSync(modeFile, m); }

function getSudos() {
  try { return fs.readFileSync(sudoFile, 'utf-8').split('\n').filter(x => x.trim()); }
  catch { return []; }
}
function addSudo(num) {
  const s = getSudos();
  if (!s.includes(num)) { s.push(num); fs.writeFileSync(sudoFile, s.join('\n')); }
}
function removeSudo(num) {
  const s = getSudos().filter(x => x !== num);
  fs.writeFileSync(sudoFile, s.join('\n'));
}

function getSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf-8')); }
  catch { return {}; }
}
function saveSettings(s) { fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); }

// === LID cache (ported from KLAUS MD) ===
const lidPhoneCache = new Map(); // LID → phone
const phoneLidCache = new Map(); // phone → LID

function cacheLidPhone(lid, phone) {
  lidPhoneCache.set(lid, phone);
  phoneLidCache.set(phone, lid);
}

function resolvePhoneFromLid(jid) {
  if (!jid || !jid.includes('@lid')) return null;
  const raw = jid.split('@')[0].split(':')[0];
  return lidPhoneCache.get(raw) || null;
}

// === JID normalization ===
function cleanJid(jid) {
  if (!jid) return { cleanJid: '', cleanNumber: '', isLid: false };
  const raw = jid.split('@')[0].split(':')[0];
  const isLid = jid.endsWith('@lid');
  return {
    cleanJid: isLid ? jid : `${raw}@s.whatsapp.net`,
    cleanNumber: raw,
    isLid,
  };
}

// === Access control ===
function isOwner(senderJid, participantPn) {
  if (!senderJid) return false;
  // Direct phone match
  const phone = senderJid.split('@')[0].split(':')[0];
  if (phone === ownerNumber) return true;
  // participantPn match (group messages with LID)
  if (participantPn) {
    const pn = participantPn.split('@')[0].split(':')[0];
    if (pn === ownerNumber) return true;
  }
  // LID → cached phone match
  if (senderJid.endsWith('@lid')) {
    const cached = resolvePhoneFromLid(senderJid);
    if (cached === ownerNumber) return true;
  }
  return false;
}

function isSudo(senderJid, participantPn) {
  if (!senderJid) return false;
  const sudos = getSudos();
  if (sudos.length === 0) return false;
  const phone = senderJid.split('@')[0].split(':')[0];
  if (sudos.includes(phone)) return true;
  if (participantPn) {
    const pn = participantPn.split('@')[0].split(':')[0];
    if (sudos.includes(pn)) return true;
  }
  if (senderJid.endsWith('@lid')) {
    const cached = resolvePhoneFromLid(senderJid);
    if (cached && sudos.includes(cached)) return true;
  }
  return false;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  const logger = P({ level: 'warn' }, P.destination({ sync: true }));

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
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
          try {
            sock.sendMessage(ownerJid, {
              text: '*`SNUGGLE X BOT IS NOW LIVE ✅`*\n> snuggle x bot\n\nType *.menu* to see commands.\nType *.all* to see the full command list.',
            });
          } catch (e) { console.error('[LIVE] send failed:', e.message); }
        }, 3000);
      }
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      console.log('[Snuggle X Bot] closed:', code);
      if (code === DisconnectReason.loggedOut) {
        console.error('[Snuggle X Bot] ❌ Session logged out. Re-pair.');
        setTimeout(() => process.exit(1), 3000);
      } else if (code === 503) {
        setTimeout(() => start(), 30000);
      } else {
        setTimeout(() => start(), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const m = messages[0];
      if (!m || !m.message) return;

      const chatId = m.key.remoteJid;
      // Skip newsletters and broadcasts
      if (chatId && (chatId.includes('newsletter') || chatId.includes('broadcast'))) return;

      // === Determine sender ===
      const isGroup = chatId && chatId.endsWith('@g.us');
      const participant = m.key.participant || chatId;
      const participantPn = m.key.participantPn || null;

      // Cache LID → phone mapping
      if (participantPn && participant && participant.endsWith('@lid')) {
        const lidRaw = participant.split('@')[0].split(':')[0];
        const pn = participantPn.split('@')[0].split(':')[0];
        cacheLidPhone(lidRaw, pn);
      }

      // === Self-chat handling ===
      const isLid = chatId && chatId.endsWith('@lid');
      const senderPhone = chatId ? chatId.split('@')[0].split(':')[0] : '';
      const isSelfChat = (senderPhone === ownerNumber && chatId && chatId.endsWith('@s.whatsapp.net')) ||
                         (isLid && m.key.fromMe);
      if (m.key.fromMe && !isSelfChat) return;

      // === Extract sender info ===
      let senderJid = isGroup ? participant : chatId;
      const senderNumber = senderJid ? senderJid.split(':')[0].split('@')[0] : '';
      const pushName = m.pushName || (isSelfChat ? 'You' : 'User');
      const ownerCheck = isOwner(senderJid, participantPn) || isSelfChat;
      const sudoCheck = isSudo(senderJid, participantPn);
      const mode = getMode();

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
      const ctx = isGroup ? `group ${chatId.split('@')[0]} from ${senderNumber}` : `dm ${senderNumber}`;
      console.log(`[CMD] ${ctx} (${pushName})${ownerCheck ? ' [OWNER]' : sudoCheck ? ' [SUDO]' : ''}: ${raw}`);

      // === ANTI features for groups (before command processing) ===
      if (isGroup) {
        const settings = getSettings();
        const groupKey = chatId;
        const groupSettings = settings[groupKey] || {};

        // Anti-link
        if (groupSettings.antilink && !ownerCheck && !sudoCheck) {
          const urlPattern = /https?:\/\/|www\.|\.com|\.net|\.org|wa\.me\/|chat\.whatsapp\.com/i;
          if (urlPattern.test(raw)) {
            try {
              await sock.sendMessage(chatId, { delete: m.key });
              await sock.groupParticipantsUpdate(chatId, [senderJid], 'remove');
              await sock.sendMessage(chatId, { text: `🚫 @${senderNumber} was removed for sending a link`, mentions: [senderJid] });
              console.log(`[ANTI] Removed ${senderNumber} for link in ${chatId}`);
            } catch (e) { console.log('[ANTI] antilink error:', e.message); }
            return;
          }
        }

        // Anti-badword
        if (groupSettings.antibadword && !ownerCheck && !sudoCheck) {
          const badwords = ['fuck', 'shit', 'bitch', 'asshole', 'dick', 'pussy', 'cunt'];
          if (badwords.some(w => lower.includes(w))) {
            try {
              await sock.sendMessage(chatId, { delete: m.key });
              await sock.sendMessage(chatId, { text: `⚠️ @${senderNumber}, bad words are not allowed here.`, mentions: [senderJid] });
              console.log(`[ANTI] Badword from ${senderNumber} in ${chatId}`);
            } catch (e) { console.log('[ANTI] antibadword error:', e.message); }
            return;
          }
        }

        // Anti-spam (simple: warn if > 5 messages in 10 seconds)
        if (groupSettings.antispam && !ownerCheck && !sudoCheck) {
          const now = Date.now();
          if (!antiSpamCache.has(chatId + senderNumber)) antiSpamCache.set(chatId + senderNumber, []);
          const arr = antiSpamCache.get(chatId + senderNumber);
          arr.push(now);
          // Keep only last 10 seconds
          while (arr.length > 0 && arr[0] < now - 10000) arr.shift();
          if (arr.length > 5) {
            try {
              await sock.sendMessage(chatId, { delete: m.key });
              await sock.sendMessage(chatId, { text: `⚠️ @${senderNumber}, stop spamming!`, mentions: [senderJid] });
              console.log(`[ANTI] Spam from ${senderNumber} in ${chatId}`);
            } catch (e) { console.log('[ANTI] antispam error:', e.message); }
            return;
          }
        }
      }

      // === Parse command ===
      const strippedRaw = raw.replace(/^[*_`~]+/, '').trim();
      const cmd = strippedRaw.toLowerCase().split(/\s+/)[0];
      const args = strippedRaw.split(/\s+/).slice(1);
      const argText = args.join(' ');

      // === BOT_MODE checks ===
      if (mode === 'silent' && !ownerCheck && !sudoCheck) return;
      if (mode === 'groups' && !isGroup && !ownerCheck && !sudoCheck) return;
      if (mode === 'dms' && isGroup && !ownerCheck && !sudoCheck) return;

      // === PUBLIC commands (.menu, .all) — work for everyone ===
      if (cmd === '.menu' || cmd === '.m' || cmd === '!menu' || cmd === '/menu' || lower === 'menu') {
        // Send menu as a contact card with the menu text as caption
        // The contact card shows the OWNER's info — users can tap "Save" to add the owner
        const fakeContact = createFakeContact(ownerNumber, ownerName);
        const menuText = buildMenu(pushName);
        try {
          await sock.sendMessage(chatId, {
            contacts: {
              displayName: ownerName && ownerName !== 'Not Set!' ? ownerName : 'Yobby King',
              contacts: [{ vcard: fakeContact.message.contactMessage.vcard }],
            },
          }, { quoted: m });
        } catch (e) {
          console.error('Contact card send failed:', e.message);
        }
        // Send the menu text right after the contact card
        await sock.sendMessage(chatId, { text: menuText }, { quoted: fakeContact });
        return;
      }
      if (cmd === '.all' || cmd === '!all' || cmd === '/all' || lower === 'all') {
        await sock.sendMessage(chatId, { text: buildAllMenu() }, { quoted: m });
        return;
      }
      if (cmd === '.ping' || cmd === '!ping' || cmd === '/ping') {
        const t = Date.now();
        await sock.sendMessage(chatId, { text: `*PONG* 🏓\nLatency: ${Date.now() - t}ms` }, { quoted: m });
        return;
      }
      if (cmd === '.help' || cmd === '!help' || cmd === '/help') {
        await sock.sendMessage(chatId, { text: `Type *.menu* for the menu, or *.all* for the full command list.` }, { quoted: m });
        return;
      }
      if (cmd === '.whoami' || cmd === '!whoami' || cmd === '/whoami') {
        await sock.sendMessage(chatId, {
          text: `*You are* ${pushName}\n*Number:* ${senderNumber}\n*Status:* ${ownerCheck ? 'Owner 👑' : sudoCheck ? 'Sudo 🔑' : 'User'}`,
        }, { quoted: m });
        return;
      }

      // === ACCESS GATE — owner/sudo only beyond this point ===
      if (!ownerCheck && !sudoCheck) {
        // Non-owner + non-sudo in private mode → deny
        if (mode === 'private' || mode === 'silent') {
          await sock.sendMessage(chatId, {
            text: '> *only sudo access 🚫*\n> Get yours 0181163563 ✅',
          }, { quoted: m });
          return;
        }
        // In public mode, non-owners can use some commands (handled above)
        // For owner/sudo-only commands below, deny:
        const ownerOnlyCommands = ['.alive', '.owner', '.mode', '.addsudo', '.delsudo', '.sudolist', '.tagall', '.hidetag', '.promote', '.demote', '.kick', '.add', '.mute', '.unmute', '.antilink', '.antispam', '.antibadword', '.antidelete', '.antilinkoff', '.antispamoff', '.antibadwordoff', '.antideleteoff'];
        if (ownerOnlyCommands.some(c => cmd === c || cmd === c.replace('.', '!') || cmd === c.replace('.', '/'))) {
          await sock.sendMessage(chatId, {
            text: '> *only sudo access 🚫*\n> Get yours 0181163563 ✅',
          }, { quoted: m });
          return;
        }
        // Unknown command for non-owner
        if (cmd.startsWith('.') || cmd.startsWith('!') || cmd.startsWith('/')) {
          await sock.sendMessage(chatId, {
            text: `Unknown command: ${cmd}\nType *.menu* to see the menu.`,
          }, { quoted: m });
        }
        return;
      }

      // === OWNER/SUDO commands ===
      switch (cmd) {
        case '.alive': case '!alive': case '/alive': {
          await sock.sendMessage(chatId, { text: buildAlive() }, { quoted: m });
          break;
        }
        case '.owner': case '!owner': case '/owner': {
          await sock.sendMessage(chatId, { text: buildOwner() }, { quoted: m });
          break;
        }
        case '.mode': case '!mode': case '/mode': {
          if (argText === 'private' || argText === 'public' || argText === 'silent' || argText === 'groups' || argText === 'dms') {
            if (!ownerCheck) {
              await sock.sendMessage(chatId, { text: '> *only owner can change mode* 🚫' }, { quoted: m });
              return;
            }
            setMode(argText);
            await sock.sendMessage(chatId, { text: `*MODE CHANGED* ✅\n> Bot is now in *${argText}* mode` }, { quoted: m });
          } else {
            await sock.sendMessage(chatId, { text: `*Current mode:* ${getMode()}\n\nUsage:\n*.mode public* — anyone can use commands\n*.mode private* — only owner/sudo\n*.mode silent* — only owner/sudo (no public commands)\n*.mode groups* — only respond in groups\n*.mode dms* — only respond in DMs` }, { quoted: m });
          }
          break;
        }

        // === Sudo management (owner only) ===
        case '.addsudo': case '!addsudo': case '/addsudo': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const num = args[0]?.replace(/[^0-9]/g, '');
          if (!num) { await sock.sendMessage(chatId, { text: 'Usage: .addsudo <number>' }, { quoted: m }); return; }
          addSudo(num);
          await sock.sendMessage(chatId, { text: `✅ Added ${num} as sudo` }, { quoted: m });
          break;
        }
        case '.delsudo': case '!delsudo': case '/delsudo': {
          if (!ownerCheck) { await sock.sendMessage(chatId, { text: '> *only owner* 🚫' }, { quoted: m }); return; }
          const num = args[0]?.replace(/[^0-9]/g, '');
          if (!num) { await sock.sendMessage(chatId, { text: 'Usage: .delsudo <number>' }, { quoted: m }); return; }
          removeSudo(num);
          await sock.sendMessage(chatId, { text: `✅ Removed ${num} from sudo` }, { quoted: m });
          break;
        }
        case '.sudolist': case '!sudolist': case '/sudolist': {
          const sudos = getSudos();
          await sock.sendMessage(chatId, { text: `*Sudo users (${sudos.length}):*\n${sudos.length > 0 ? sudos.map(s => '• ' + s).join('\n') : 'None'}` }, { quoted: m });
          break;
        }

        // === Group management commands ===
        case '.tagall': case '!tagall': case '/tagall': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'This command only works in groups' }, { quoted: m }); return; }
          try {
            const groupMetadata = await sock.groupMetadata(chatId);
            const mentions = groupMetadata.participants.map(p => p.id);
            const text = `┏▣ *SNUGGLE X TAG ALL* ▣\n┗▣ Total: ${mentions.length} members\n\n` + mentions.map(p => '➽ @' + p.split('@')[0]).join('\n');
            await sock.sendMessage(chatId, { text, mentions });
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case '.hidetag': case '!hidetag': case '/hidetag': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'This command only works in groups' }, { quoted: m }); return; }
          try {
            const groupMetadata = await sock.groupMetadata(chatId);
            const mentions = groupMetadata.participants.map(p => p.id);
            const tagText = argText || '👥';
            await sock.sendMessage(chatId, { text: tagText, mentions });
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case '.promote': case '!promote': case '/promote': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'This command only works in groups' }, { quoted: m }); return; }
          const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!target) { await sock.sendMessage(chatId, { text: 'Mention a user to promote' }, { quoted: m }); return; }
          try {
            await sock.groupParticipantsUpdate(chatId, [target], 'promote');
            await sock.sendMessage(chatId, { text: `✅ Promoted @${target.split('@')[0]}`, mentions: [target] }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case '.demote': case '!demote': case '/demote': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'This command only works in groups' }, { quoted: m }); return; }
          const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!target) { await sock.sendMessage(chatId, { text: 'Mention a user to demote' }, { quoted: m }); return; }
          try {
            await sock.groupParticipantsUpdate(chatId, [target], 'demote');
            await sock.sendMessage(chatId, { text: `✅ Demoted @${target.split('@')[0]}`, mentions: [target] }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case '.kick': case '!kick': case '/kick': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'This command only works in groups' }, { quoted: m }); return; }
          const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!target) { await sock.sendMessage(chatId, { text: 'Mention a user to kick' }, { quoted: m }); return; }
          try {
            await sock.groupParticipantsUpdate(chatId, [target], 'remove');
            await sock.sendMessage(chatId, { text: `✅ Kicked @${target.split('@')[0]}`, mentions: [target] }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }
        case '.add': case '!add': case '/add': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'This command only works in groups' }, { quoted: m }); return; }
          const num = args[0]?.replace(/[^0-9]/g, '');
          if (!num) { await sock.sendMessage(chatId, { text: 'Usage: .add <number>' }, { quoted: m }); return; }
          try {
            const target = `${num}@s.whatsapp.net`;
            const resp = await sock.groupParticipantsUpdate(chatId, [target], 'add');
            await sock.sendMessage(chatId, { text: `✅ Added ${num}`, mentions: [target] }, { quoted: m });
          } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          break;
        }

        // === Anti-commands (toggle) ===
        case '.antilink': case '!antilink': case '/antilink': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          const s = getSettings(); const gs = s[chatId] || {};
          gs.antilink = !gs.antilink; s[chatId] = gs; saveSettings(s);
          await sock.sendMessage(chatId, { text: `*ANTILINK ${gs.antilink ? 'ON ✅' : 'OFF ❌'}*` }, { quoted: m });
          break;
        }
        case '.antispam': case '!antispam': case '/antispam': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          const s = getSettings(); const gs = s[chatId] || {};
          gs.antispam = !gs.antispam; s[chatId] = gs; saveSettings(s);
          await sock.sendMessage(chatId, { text: `*ANTISPAM ${gs.antispam ? 'ON ✅' : 'OFF ❌'}*` }, { quoted: m });
          break;
        }
        case '.antibadword': case '!antibadword': case '/antibadword': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          const s = getSettings(); const gs = s[chatId] || {};
          gs.antibadword = !gs.antibadword; s[chatId] = gs; saveSettings(s);
          await sock.sendMessage(chatId, { text: `*ANTIBADWORD ${gs.antibadword ? 'ON ✅' : 'OFF ❌'}*` }, { quoted: m });
          break;
        }
        case '.antidelete': case '!antidelete': case '/antidelete': {
          if (!isGroup) { await sock.sendMessage(chatId, { text: 'Group only' }, { quoted: m }); return; }
          const s = getSettings(); const gs = s[chatId] || {};
          gs.antidelete = !gs.antidelete; s[chatId] = gs; saveSettings(s);
          await sock.sendMessage(chatId, { text: `*ANTIDELETE ${gs.antidelete ? 'ON ✅' : 'OFF ❌'}*` }, { quoted: m });
          break;
        }

        // === Media commands ===
        case '.sticker': case '!sticker': case '/sticker': {
          if (msg.imageMessage || msg.videoMessage || msg.viewOnceMessage?.message?.imageMessage || msg.viewOnceMessage?.message?.videoMessage) {
            try {
              const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: P({ level: 'silent' }) });
              await sock.sendMessage(chatId, { sticker: Buffer.from(buf) }, { quoted: m });
            } catch (e) { await sock.sendMessage(chatId, { text: `Failed: ${e.message}` }, { quoted: m }); }
          } else {
            await sock.sendMessage(chatId, { text: 'Send an image/video with caption .sticker' }, { quoted: m });
          }
          break;
        }
        case '.url': case '!url': case '/url': {
          await handleUrlCommand(sock, chatId, m, msg);
          break;
        }

        default:
          if (cmd.startsWith('.') || cmd.startsWith('!') || cmd.startsWith('/')) {
            await sock.sendMessage(chatId, { text: `Unknown command: ${cmd}\nType *.menu* or *.all* for the list.` }, { quoted: m });
          }
      }
    } catch (e) {
      console.error('[messages.upsert error]', e.message);
    }
  });

  // === Anti-delete handler ===
  sock.ev.on('messages.update', async (updates) => {
    try {
      const settings = getSettings();
      for (const update of updates) {
        const chatId = update.key?.remoteJid;
        if (!chatId || !chatId.endsWith('@g.us')) continue;
        const gs = settings[chatId] || {};
        if (!gs.antidelete) continue;
        // If message was deleted
        if (update.update?.message?.protocolMessage?.type === 0 || update.update?.status === 'deleted') {
          // Re-send the deleted message (if we have it in store)
          try {
            const key = update.key;
            const msg = await sock.loadMessage?.(chatId, key.id);
            if (msg) {
              await sock.sendMessage(chatId, { text: `🚫 *Anti-Delete:* A message was deleted by ${key.participant || 'someone'}` });
              // Forward the deleted message
              await sock.sendMessage(chatId, { forward: msg });
            }
          } catch (e) { console.log('[ANTIDELETE] error:', e.message); }
        }
      }
    } catch (e) { console.log('[ANTIDELETE] error:', e.message); }
  });
}

// === Anti-spam cache ===
const antiSpamCache = new Map();

// ============================================================
// === .url command — uploads media to tmpfiles.org ===
// ============================================================
async function handleUrlCommand(sock, chatId, m, msg) {
  const hasMedia = msg.imageMessage || msg.videoMessage || msg.audioMessage ||
                   msg.documentMessage || msg.stickerMessage ||
                   msg.viewOnceMessage?.message?.imageMessage ||
                   msg.viewOnceMessage?.message?.videoMessage;
  if (!hasMedia) {
    await sock.sendMessage(chatId, {
      text: '📎 *Send media with caption .url*\n\nSupported: image, video, audio, document, sticker\n\nI will upload it and give you a public URL.',
    }, { quoted: m });
    return;
  }
  await sock.sendMessage(chatId, { text: '⏳ Uploading to get URL...' }, { quoted: m });
  try {
    // Use baileys' downloadMediaMessage function (not sock.downloadMediaMessage)
    const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: P({ level: 'silent' }) });
    const buffer = Buffer.from(buf);
    let mime = 'application/octet-stream';
    let ext = 'bin';
    if (msg.imageMessage) { mime = msg.imageMessage.mimetype || 'image/jpeg'; ext = mime.split('/')[1] || 'jpg'; }
    else if (msg.videoMessage) { mime = msg.videoMessage.mimetype || 'video/mp4'; ext = mime.split('/')[1] || 'mp4'; }
    else if (msg.audioMessage) { mime = msg.audioMessage.mimetype || 'audio/mpeg'; ext = 'mp3'; }
    else if (msg.documentMessage) { mime = msg.documentMessage.mimetype || 'application/octet-stream'; ext = msg.documentMessage.fileName?.split('.').pop() || 'bin'; }
    else if (msg.stickerMessage) { mime = msg.stickerMessage.mimetype || 'image/webp'; ext = 'webp'; }
    else if (msg.viewOnceMessage?.message?.imageMessage) { mime = msg.viewOnceMessage.message.imageMessage.mimetype || 'image/jpeg'; ext = 'jpg'; }
    else if (msg.viewOnceMessage?.message?.videoMessage) { mime = msg.viewOnceMessage.message.videoMessage.mimetype || 'video/mp4'; ext = 'mp4'; }
    const FormData = require('form-data');
    const axios = require('axios');
    const form = new FormData();
    const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5) || 'bin';
    form.append('file', buffer, `upload.${safeExt}`);
    const upRes = await axios.post('https://tmpfiles.org/api/v1/upload', form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 60000,
    });
    if (upRes.data?.data?.url) {
      const rawUrl = upRes.data.data.url;
      const directUrl = rawUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
      await sock.sendMessage(chatId, {
        text: `✅ *Media uploaded!*\n\n🔗 *URL:*\n${directUrl}\n\n_Size: ${(buffer.length / 1024).toFixed(1)} KB_\n_Type: ${mime}_`,
      }, { quoted: m });
    } else {
      throw new Error('Upload returned no URL');
    }
  } catch (e) {
    console.error('[.url] upload failed:', e.message);
    await sock.sendMessage(chatId, { text: `❌ Failed to upload: ${e.message}\n\nTry again with a smaller file.` }, { quoted: m });
  }
}

// ============================================================
// === MENU BUILDERS ===
// ============================================================
function buildMenu(pushName) {
  const mem = process.memoryUsage();
  const memMB = (mem.rss / 1024 / 1024).toFixed(0);
  const totalRAM = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  const ramPct = Math.min(100, Math.round((mem.rss / os.totalmem()) * 100));
  const ramBarLen = 10;
  const ramFilled = Math.round((ramPct / 100) * ramBarLen);
  const ramBar = '█'.repeat(ramFilled) + '░'.repeat(ramBarLen - ramFilled);
  const mode = getMode();
  return `┏▣ ◈ *_SNUGGLE-X_* ◈     
┃ *\`ᴏᴡɴᴇʀ\`* : ${ownerName}
┃ *\`ɴᴜᴍʙᴇʀ\`* : ${ownerNumber}
┃ *\`ᴘʀᴇғɪx\`* : [ . ]
┃ *\`ᴍᴏᴅᴇ\`* : ${mode === 'private' ? 'Private' : mode}
┃ *\`ᴜsᴀɢᴇ\`* : ${memMB} MB of ${totalRAM} GB  
┃ *\`ʀᴀᴍ\`*: [${ramBar}] ${ramPct}%
┃ *\`ᴜᴘᴛɪᴍᴇ\`* : ${formatUptime(process.uptime())}
┗▣

> created by yobby king

> Instagram @yobby_mking

\`Command .all to see full command list ✅❤️\``;
}

function buildAllMenu() {
  return `╭═══════════════════════✦═╗
║   *SNUGGLE X • FULL COMMANDS*   ║
╚═══════════════════════✦═╝

╭─ ❲ 🌐 PUBLIC ❳
├ .menu — show main menu
├ .all — show full command list
├ .ping — latency check
├ .help — quick help
├ .whoami — your info
╰────────────────────

╭─ ❲ 👑 OWNER ❳
├ .alive — bot status
├ .owner — owner info
├ .mode — show current mode
├ .mode public/private/silent/groups/dms
├ .addsudo <number> — add sudo user
├ .delsudo <number> — remove sudo
├ .sudolist — list sudo users
╰────────────────────

╭─ ❲ 👥 GROUP ❳
├ .tagall — tag everyone
├ .hidetag <text> — hidden tag
├ .promote @user — promote
├ .demote @user — demote
├ .kick @user — kick member
├ .add <number> — add member
╰────────────────────

╭─ ❲ 🛡 ANTI ❳
├ .antilink — toggle anti-link
├ .antispam — toggle anti-spam
├ .antibadword — toggle anti-badword
├ .antidelete — toggle anti-delete
╰────────────────────

╭─ ❲ 🎨 MEDIA ❳
├ .sticker — convert image/video to sticker
├ .url — upload media and get a public URL
╰────────────────────

*SNUGGLE X* · Created by Yobby King
> Instagram @yobby_mking
> Contact dev: 0795314221 / 0181163563`;
}

function buildAlive() {
  const mem = process.memoryUsage();
  const memMB = (mem.rss / 1024 / 1024).toFixed(0);
  return `*SNUGGLE X IS ALIVE ✅*
> snuggle x bot
> status: online 🟢
> owner: ${ownerName}
> number: ${ownerNumber}
> mode: ${getMode()}
> uptime: ${formatUptime(process.uptime())}
> memory: ${memMB} MB`;
}

function buildOwner() {
  return `*BOT OWNER* 👑
> Name: Yobby King
> Number: ${ownerNumber}
> Instagram: @yobby_mking
> Contact dev: 0795314221 / 0181163563`;
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
