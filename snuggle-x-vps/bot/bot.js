// Snuggle X Bot — runs as a pm2 process per user.
// Usage: node bot.js <sessionIdBase64>

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
  const gzipped = Buffer.from(b64, 'base64');
  const json = zlib.gunzipSync(gzipped).toString('utf-8');
  sessionFiles = JSON.parse(json);
} catch (e) {
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

// === Mode file ===
const modeFile = path.join(sessionDir, 'mode.txt');
function getMode() {
  try { return fs.readFileSync(modeFile, 'utf-8').trim() || 'public'; }
  catch { return 'public'; }
}
function setMode(mode) {
  fs.writeFileSync(modeFile, mode);
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
  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'open') {
      console.log('[Snuggle X Bot] ✅ Connected as', sock.user.id);
      if (isStarting) {
        isStarting = false;
        setTimeout(() => {
          sock.sendMessage(ownerJid, {
            text: '*`SNUGGLE X BOT IS NOW LIVE ✅`*\n> snuggle x bot\n\nType *.menu* to see commands.\nType *.all* to see the full command list.',
          }).catch(() => {});
        }, 3000);
      }
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      console.log('[Snuggle X Bot] closed:', code);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => start(), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const m = messages[0];
      if (!m || !m.message || m.key.fromMe) return;

      const sender = m.key.remoteJid;
      // Skip newsletters and broadcasts
      if (sender && (sender.includes('newsletter') || sender.includes('broadcast') || sender.endsWith('@lid'))) {
        return;
      }

      const senderNumber = sender.split(':')[0].split('@')[0];
      const pushName = m.pushName || 'User';
      const isOwner = senderNumber === ownerNumber;
      const mode = getMode();

      // Extract text from any message type
      let text = '';
      const msg = m.message;
      if (msg.conversation) text = msg.conversation;
      else if (msg.extendedTextMessage?.text) text = msg.extendedTextMessage.text;
      else if (msg.imageMessage?.caption) text = msg.imageMessage.caption;
      else if (msg.videoMessage?.caption) text = msg.videoMessage.caption;
      else if (msg.viewOnceMessage?.message?.imageMessage?.caption) text = msg.viewOnceMessage.message.imageMessage.caption;
      else if (msg.viewOnceMessage?.message?.videoMessage?.caption) text = msg.viewOnceMessage.message.videoMessage.caption;
      else return;

      const raw = text.trim();
      if (!raw) return;
      const cmd = raw.toLowerCase().split(/\s+/)[0];
      console.log(`[CMD] ${senderNumber} (${pushName}): ${raw}`);

      // === PUBLIC commands (work for everyone) ===
      if (cmd === '.menu' || cmd === '.m' || cmd === '!menu' || cmd === '/menu') {
        await sendMenu(sender, m, pushName);
        return;
      }
      if (cmd === '.all' || cmd === '!all' || cmd === '/all') {
        await sendAllMenu(sender, m);
        return;
      }

      // === PRIVATE commands (only owner, OR public mode allows everyone) ===
      const isPrivileged = isOwner || mode === 'public';
      if (!isPrivileged) {
        // Non-owner in private mode: deny with custom message
        await sock.sendMessage(sender, {
          text: '> *only sudo access 🚫*\n> Get yours 0181163563 ✅',
        }, { quoted: m });
        return;
      }

      // === Mode toggle (owner only) ===
      if (raw.toLowerCase() === '.mode private' || raw.toLowerCase() === '.mode public') {
        if (!isOwner) {
          await sock.sendMessage(sender, { text: '> *only owner can change mode* 🚫' }, { quoted: m });
          return;
        }
        const newMode = raw.toLowerCase().includes('private') ? 'private' : 'public';
        setMode(newMode);
        await sock.sendMessage(sender, {
          text: `*MODE CHANGED* ✅\n> Bot is now in *${newMode}* mode\n> ${newMode === 'private' ? 'Only owner can use full commands' : 'Anyone can use all commands'}`,
        }, { quoted: m });
        return;
      }
      if (cmd === '.mode') {
        await sock.sendMessage(sender, {
          text: `*Current mode:* ${getMode()}\n\nUsage:\n*.mode private* — only owner can use commands (except .menu and .all)\n*.mode public* — anyone can use all commands`,
        }, { quoted: m });
        return;
      }

      // === Owner-only commands ===
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
          if (msg.imageMessage || msg.videoMessage || msg.viewOnceMessage?.message?.imageMessage || msg.viewOnceMessage?.message?.videoMessage) {
            try {
              const buf = await sock.downloadMediaMessage(m);
              await sock.sendMessage(sender, { sticker: Buffer.from(buf) }, { quoted: m });
            } catch {
              await sock.sendMessage(sender, { text: 'Failed to make sticker 😢' }, { quoted: m });
            }
          } else {
            await sock.sendMessage(sender, { text: 'Send an image/video with caption .sticker' }, { quoted: m });
          }
          break;
        }
        case '.url': case '!url': case '/url': {
          await handleUrlCommand(sock, sender, m, msg);
          break;
        }
        case '.help': case '!help': case '/help': {
          await sock.sendMessage(sender, { text: `Type *.menu* for the menu, or *.all* for the full command list.` }, { quoted: m });
          break;
        }
        case '.whoami': case '!whoami': case '/whoami': {
          await sock.sendMessage(sender, {
            text: `*You are* ${pushName}\n*Number:* ${senderNumber}\n*Status:* ${isOwner ? 'Owner 👑' : 'User'}`,
          }, { quoted: m });
          break;
        }
        default:
          if (cmd.startsWith('.') || cmd.startsWith('!') || cmd.startsWith('/')) {
            await sock.sendMessage(sender, {
              text: `Unknown command: ${cmd}\nType *.menu* to see the menu, or *.all* for full list.`,
            }, { quoted: m });
          }
      }
    } catch (e) {
      console.error('[messages.upsert error]', e.message);
    }
  });
}

// ============================================================
// === MENU with vCard contact card ===
// ============================================================
async function sendMenu(sender, m, pushName) {
  const text = buildMenu(pushName);
  // Send vCard contact card first (shows in chat as a tappable contact)
  const vcard = 'BEGIN:VCARD\n'
    + 'VERSION:3.0\n'
    + 'FN:Snuggle X Bot\n'
    + 'ORG:Snuggle X Platform;\n'
    + 'TEL;type=CELL;type=VOICE;waid=254181163563:+254 181163563\n'
    + 'EMAIL:snuggle-x@bot.ai\n'
    + 'URL:https://github.com/yobbyking/snuggle-x-pair\n'
    + 'NOTE:Snuggle X WhatsApp Bot\\nCreated by Yobby King\\nInstagram: @yobby_mking\\nContact dev: 0181163563\n'
    + 'END:VCARD';
  try {
    await sock.sendMessage(sender, {
      contacts: {
        displayName: 'Snuggle X Bot',
        contacts: [{ vcard }],
      },
    }, { quoted: m });
  } catch (e) {
    console.error('vCard send failed:', e.message);
  }
  await sock.sendMessage(sender, { text }, { quoted: m });
}

async function sendAllMenu(sender, m) {
  await sock.sendMessage(sender, { text: buildAllMenu() }, { quoted: m });
}

// ============================================================
// === .url command — converts media to a URL ===
// ============================================================
async function handleUrlCommand(sock, sender, m, msg) {
  // Check if message has media
  const hasMedia = msg.imageMessage || msg.videoMessage || msg.audioMessage ||
                   msg.documentMessage || msg.stickerMessage ||
                   msg.viewOnceMessage?.message?.imageMessage ||
                   msg.viewOnceMessage?.message?.videoMessage;
  if (!hasMedia) {
    await sock.sendMessage(sender, {
      text: '📎 *Send media with caption .url*\n\nSupported: image, video, audio, document, sticker\n\nI will upload it and give you a public URL.',
    }, { quoted: m });
    return;
  }
  await sock.sendMessage(sender, { text: '⏳ Uploading to get URL...' }, { quoted: m });
  try {
    const buf = await sock.downloadMediaMessage(m);
    const buffer = Buffer.from(buf);
    // Get mime type
    let mime = 'application/octet-stream';
    let ext = 'bin';
    if (msg.imageMessage) { mime = msg.imageMessage.mimetype || 'image/jpeg'; ext = mime.split('/')[1] || 'jpg'; }
    else if (msg.videoMessage) { mime = msg.videoMessage.mimetype || 'video/mp4'; ext = mime.split('/')[1] || 'mp4'; }
    else if (msg.audioMessage) { mime = msg.audioMessage.mimetype || 'audio/mpeg'; ext = 'mp3'; }
    else if (msg.documentMessage) { mime = msg.documentMessage.mimetype || 'application/octet-stream'; ext = msg.documentMessage.fileName?.split('.').pop() || 'bin'; }
    else if (msg.stickerMessage) { mime = msg.stickerMessage.mimetype || 'image/webp'; ext = 'webp'; }
    else if (msg.viewOnceMessage?.message?.imageMessage) { mime = msg.viewOnceMessage.message.imageMessage.mimetype || 'image/jpeg'; ext = 'jpg'; }
    else if (msg.viewOnceMessage?.message?.videoMessage) { mime = msg.viewOnceMessage.message.videoMessage.mimetype || 'video/mp4'; ext = 'mp4'; }
    // Use tmpfiles.org (free, no auth, simple API)
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
      // Convert tmpfiles.org URL to direct download URL
      const rawUrl = upRes.data.data.url;
      const directUrl = rawUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
      await sock.sendMessage(sender, {
        text: `✅ *Media uploaded!*\n\n🔗 *URL:*\n${directUrl}\n\n_Size: ${(buffer.length / 1024).toFixed(1)} KB_\n_Type: ${mime}_`,
      }, { quoted: m });
    } else {
      throw new Error('Upload returned no URL');
    }
  } catch (e) {
    console.error('[.url] upload failed:', e.message);
    await sock.sendMessage(sender, {
      text: `❌ Failed to upload: ${e.message}\n\nTry again with a smaller file.`,
    }, { quoted: m });
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
┃ *\`ᴍᴏᴅᴇ\`* : ${mode === 'private' ? 'Private' : 'Public'}
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

╭─ ❲ 🌐 PUBLIC (everyone) ❳
├ .menu — show main menu + contact card
├ .all — show this full list
╰────────────────────

╭─ ❲ 👑 OWNER ❳
├ .alive — bot status
├ .owner — owner info
├ .ping — latency check
├ .whoami — your session info
├ .mode — show current mode
├ .mode private — only owner can use commands
├ .mode public — anyone can use commands
├ .help — quick help
╰────────────────────

╭─ ❲ 🎨 MEDIA ❳
├ .sticker — convert image/video to sticker
├ .url — upload media and get a public URL
├ .toimg — (coming soon)
╰────────────────────

╭─ ❲ 🛠 UTILS ❳
├ .time — current time
├ .date — current date
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
