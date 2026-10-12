// Snuggle X Bot — runs as a pm2 process per user.
// Usage: node bot.js <sessionIdBase64>
// The sessionIdBase64 starts with "yobbyx:~" prefix.

const { useMultiFileAuthState, makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.error('Usage: node bot.js <yobbyx:~sessionBase64>');
  process.exit(1);
}

// Strip prefix
const b64 = SESSION_ID.replace(/^yobbyx:~/, '');
let sessionFiles;
try {
  sessionFiles = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
} catch (e) {
  console.error('Invalid session ID');
  process.exit(1);
}

// Determine owner number from the session files (we saved owner.txt earlier? Actually we need to figure it out)
// Actually we saved creds.json — the owner JID is in there
let ownerJid = null;
if (sessionFiles['creds.json']) {
  try {
    const creds = JSON.parse(Buffer.from(sessionFiles['creds.json'], 'base64').toString('utf-8'));
    if (creds.me && creds.me.id) ownerJid = creds.me.id;
  } catch {}
}
const ownerNumber = ownerJid ? ownerJid.split(':')[0].split('@')[0] : null;
console.log(`[Snuggle X Bot] Owner: ${ownerNumber} (${ownerJid})`);

// Write session files to a folder — sessions are at parent dir
const sessionDir = path.join(__dirname, '..', 'sessions', 'bot-' + (ownerNumber || Date.now()));
fs.mkdirSync(sessionDir, { recursive: true });
for (const [name, b64content] of Object.entries(sessionFiles)) {
  const fp = path.join(sessionDir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, Buffer.from(b64content, 'base64'));
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.appropriate('Chrome'),
    logger: require('pino')({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'open') {
      console.log('[Snuggle X Bot] Connected as', sock.user.id);
      // Send a "now active" message to owner
      sock.sendMessage(ownerJid, {
        text: '*`SNUGGLE X BOT IS NOW LIVE ✅`*\n> snuggle x bot\n\nType *.menu* to see all commands.',
      }).catch(() => {});
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      console.log('[Snuggle X Bot] closed:', code);
      if (code !== DisconnectReason.loggedOut) {
        start(); // Reconnect
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m || !m.message || m.key.fromMe) return;

    const sender = m.key.remoteJid;
    const senderNumber = sender.split(':')[0].split('@')[0];

    // === PRIVATE BOT — only respond to owner ===
    if (senderNumber !== ownerNumber) return;

    // Extract text
    let text = '';
    if (m.message.conversation) text = m.message.conversation;
    else if (m.message.extendedTextMessage?.text) text = m.message.extendedTextMessage.text;
    else if (m.message.imageMessage?.caption) text = m.message.imageMessage.caption;
    else return;

    const cmd = text.trim().toLowerCase().split(/\s+/)[0];
    console.log(`[CMD] ${senderNumber}: ${text}`);

    switch (cmd) {
      case '.menu': case '!menu': case '/menu':
        await sock.sendMessage(sender, { text: getMenu() });
        break;
      case '.alive': case '!alive':
        await sock.sendMessage(sender, { text: getAlive() });
        break;
      case '.owner': case '!owner':
        await sock.sendMessage(sender, { text: getOwner() });
        break;
      case '.ping': case '!ping':
        const start = Date.now();
        await sock.sendMessage(sender, { text: `*PONG* 🏓\nLatency: ${Date.now() - start}ms` });
        break;
      case '.sticker': case '!sticker':
        if (m.message.imageMessage) {
          const buf = await sock.downloadMediaMessage(m);
          await sock.sendMessage(sender, {
            sticker: Buffer.from(buf),
          }, { quoted: m });
        } else {
          await sock.sendMessage(sender, { text: 'Send an image with caption .sticker' });
        }
        break;
      case '.help': case '!help':
        await sock.sendMessage(sender, { text: getHelp() });
        break;
      default:
        if (cmd.startsWith('.')) {
          await sock.sendMessage(sender, { text: `Unknown command: ${cmd}\nType *.menu* to see all commands.` });
        }
    }
  });
}

function getMenu() {
  return `
╭═══ ❲ 💕 SNUGGLE X BOT ❳ ═══╗
║   *Owner:* ${ownerNumber}
║   *Status:* ✅ Online
║   *Mode:* Private
╰═══════════════════════╯

╭─ ❲ 👑 OWNER ❳
├ .ping — check latency
├ .alive — bot status
├ .owner — owner info
├ .menu — this menu
╰────────────────────

╭─ ❲ 🎨 MEDIA ❳
├ .sticker — convert image to sticker
├ .toimg — (coming soon)
╰────────────────────

╭─ ❲ 🛠 UTILS ❳
├ .help — quick help
╜ .time — current time
╰────────────────────

*Snuggle X* · Made with 💕
*Contact:* 0795314221 / 0181163563
`;
}

function getAlive() {
  return `
*SNUGGLE X IS ALIVE ✅*
> snuggle x bot
> status: online
> owner: ${ownerNumber}
> uptime: ${process.uptime() ? Math.floor(process.uptime()/60) + ' min' : 'just started'}
`;
}

function getOwner() {
  return `
*BOT OWNER* 👑
> Name: Yobby King
> Number: ${ownerNumber}
> Contact dev: 0795314221 / 0181163563
`;
}

function getHelp() {
  return `Type *.menu* to see all available commands. 💕`;
}

start().catch(console.error);
