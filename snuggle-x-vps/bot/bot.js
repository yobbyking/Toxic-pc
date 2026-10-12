// Snuggle X Bot — runs as a pm2 process per user.
// Usage: node bot.js <sessionIdBase64>
// The sessionIdBase64 starts with "yobbyx:~" prefix.

const {
  useMultiFileAuthState,
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const P = require('pino');

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.error('Usage: node bot.js <yobbyx:~sessionBase64>');
  process.exit(1);
}

const b64 = SESSION_ID.replace(/^yobbyx:~/, '');
let sessionFiles;
try {
  // New format: base64 → gzip → JSON
  const gzipped = Buffer.from(b64, 'base64');
  const json = zlib.gunzipSync(gzipped).toString('utf-8');
  sessionFiles = JSON.parse(json);
} catch (e) {
  // Fallback: old format (plain JSON + base64) for backward compat
  try {
    sessionFiles = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch (e2) {
    console.error('Invalid session ID');
    process.exit(1);
  }
}

let ownerJid = null;
let ownerName = 'Not Set!';
if (sessionFiles['creds.json']) {
  try {
    const creds = JSON.parse(Buffer.from(sessionFiles['creds.json'], 'base64').toString('utf-8'));
    if (creds.me && creds.me.id) {
      ownerJid = creds.me.id;
      ownerName = creds.me.name || 'Not Set!';
    }
  } catch {}
}
const ownerNumber = ownerJid ? ownerJid.split(':')[0].split('@')[0] : null;
console.log(`[Snuggle X Bot] Owner: ${ownerNumber} (${ownerJid})`);

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
  const logger = P({ level: 'warn' }, P.destination({ sync: true }));

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    browser: Browsers.appropriate('Chrome'),
    logger,
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: 120000,
    connectTimeoutMs: 120000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 2000,
    linkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  let isStarting = true;
  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'open') {
      console.log('[Snuggle X Bot] ✅ Connected as', sock.user.id);
      if (isStarting) {
        isStarting = false;
        sock.sendMessage(ownerJid, {
          text: '*`SNUGGLE X BOT IS NOW LIVE ✅`*\n> snuggle x bot\n\nType *.menu* to see commands. Type *.all* to see the full command list.',
        }).catch(() => {});
      }
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      console.log('[Snuggle X Bot] closed:', code);
      if (code !== DisconnectReason.loggedOut) {
        start();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m || !m.message || m.key.fromMe) return;

    const sender = m.key.remoteJid;
    const senderNumber = sender.split(':')[0].split('@')[0];
    const pushName = m.pushName || 'User';

    // === PRIVATE BOT — only respond to owner ===
    if (senderNumber !== ownerNumber) return;

    let text = '';
    if (m.message.conversation) text = m.message.conversation;
    else if (m.message.extendedTextMessage?.text) text = m.message.extendedTextMessage.text;
    else if (m.message.imageMessage?.caption) text = m.message.imageMessage.caption;
    else if (m.message.videoMessage?.caption) text = m.message.videoMessage.caption;
    else return;

    const raw = text.trim();
    const cmd = raw.toLowerCase().split(/\s+/)[0];
    console.log(`[CMD] ${senderNumber}: ${raw}`);

    // === Main menu (.menu or .m) ===
    if (cmd === '.menu' || cmd === '.m' || cmd === '!menu' || cmd === '/menu') {
      await sock.sendMessage(sender, { text: buildMenu(pushName) }, { quoted: m });
      return;
    }

    // === Full command list (.all) ===
    if (cmd === '.all' || cmd === '!all' || cmd === '/all') {
      await sock.sendMessage(sender, { text: buildAllMenu() }, { quoted: m });
      return;
    }

    // === Other commands ===
    switch (cmd) {
      case '.ping': case '!ping': case '/ping': {
        const t = Date.now();
        await sock.sendMessage(sender, { text: `*PONG* 🏓\nLatency: ${Date.now() - t}ms` }, { quoted: m });
        break;
      }
      case '.alive': case '!alive': case '/alive': {
        await sock.sendMessage(sender, { text: buildAlive() }, { quoted: m });
        break;
      }
      case '.owner': case '!owner': case '/owner': {
        await sock.sendMessage(sender, { text: buildOwner() }, { quoted: m });
        break;
      }
      case '.sticker': case '!sticker': case '/sticker': {
        if (m.message.imageMessage) {
          try {
            const buf = await sock.downloadMediaMessage(m);
            await sock.sendMessage(sender, {
              sticker: Buffer.from(buf),
            }, { quoted: m });
          } catch {
            await sock.sendMessage(sender, { text: 'Failed to make sticker 😢' }, { quoted: m });
          }
        } else {
          await sock.sendMessage(sender, { text: 'Send an image with caption .sticker' }, { quoted: m });
        }
        break;
      }
      case '.help': case '!help': case '/help': {
        await sock.sendMessage(sender, { text: `Type *.menu* for the bot menu, or *.all* for the full command list.` }, { quoted: m });
        break;
      }
      case '.whoami': case '!whoami': case '/whoami': {
        await sock.sendMessage(sender, { text: `*You are* ${pushName}\n*Number:* ${senderNumber}\n*Status:* Owner 👑` }, { quoted: m });
        break;
      }
      default:
        if (cmd.startsWith('.') || cmd.startsWith('!') || cmd.startsWith('/')) {
          await sock.sendMessage(sender, { text: `Unknown command: ${cmd}\nType *.menu* to see the menu, or *.all* for full list.` }, { quoted: m });
        }
    }
  });
}

// ============================================================
// === MENU BUILDERS ===
// ============================================================

function buildMenu(pushName) {
  const mem = process.memoryUsage();
  const memMB = (mem.rss / 1024 / 1024).toFixed(0);
  const totalRAM = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  const usedRAM = (mem.rss / 1024 / 1024 / 1024).toFixed(1);
  // RAM usage as % of system total
  const ramPct = Math.min(100, Math.round((mem.rss / os.totalmem()) * 100));
  const ramBarLen = 10;
  const ramFilled = Math.round((ramPct / 100) * ramBarLen);
  const ramBar = '█'.repeat(ramFilled) + '░'.repeat(ramBarLen - ramFilled);

  return `┏▣ ◈ *_SNUGGLE-X_* ◈     
┃ *\`ᴏᴡɴᴇʀ\`* : ${ownerName}
┃ *\`ɴᴜᴍʙᴇʀ\`* : ${ownerNumber}
┃ *\`ᴘʀᴇғɪx\`* : [ . ]
┃ *\`ᴍᴏᴅᴇ\`* : Private
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

╭─ ❲ 👑 OWNER ❳
├ .menu — show main menu
├ .all — show this full list
├ .alive — bot status
├ .owner — owner info
├ .ping — latency check
├ .whoami — your session info
├ .help — quick help
╰────────────────────

╭─ ❲ 🎨 MEDIA ❳
├ .sticker — convert image to sticker
├ .toimg — (coming soon)
├ .mp3 — (coming soon)
╰────────────────────

╭─ ❲ 🛠 UTILS ❳
├ .time — current time
├ .date — current date
├ .joke — random joke
├ .quote — random quote
╰────────────────────

╭─ ❲ 🌐 GROUP ❳
├ .tagall — tag everyone
├ .hidetag — hidden tag
├ .promote — promote user
├ .demote — demote user
╰────────────────────

╭─ ❲ 🎭 FUN ❳
├ .truth — truth question
├ .dare — dare challenge
├ .8ball — magic 8 ball
├ .ship — compatibility check
╰────────────────────

╭─ ❲ ⚙️ SETTINGS ❳
├ .setname — change bot display name
├ .setprefix — change command prefix
├ .mode — toggle public/private
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
