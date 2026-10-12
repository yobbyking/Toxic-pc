// Snuggle X Admin Dashboard — runs on VPS port 2002
// Admin can: see all session IDs, deploy bots, view running bots, stop bots

const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = 2002;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'yobby1'; // default, change via env

// Folders
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Simple session tokens for admin
const adminTokens = new Set();
function makeToken() {
  const t = crypto.randomBytes(32).toString('hex');
  adminTokens.add(t);
  setTimeout(() => adminTokens.delete(t), 24 * 60 * 60 * 1000); // 24h
  return t;
}

// In-memory bot registry
const bots = new Map(); // botId -> { id, sessionId, ownerNumber, status, pm2Name, startedAt }

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function auth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// === Login ===
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = makeToken();
    return res.json({ token });
  }
  return res.status(401).json({ error: 'Wrong password' });
});

// === List bots ===
app.get('/api/bots', auth, (req, res) => {
  const list = Array.from(bots.values()).map(b => ({
    ...b,
    pid: getBotPid(b.pm2Name),
  }));
  res.json({ bots: list });
});

// === Deploy a bot from a session ID ===
app.post('/api/deploy', auth, (req, res) => {
  const { sessionId, label } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  if (!sessionId.startsWith('yobbyx:~')) return res.status(400).json({ error: 'Invalid session ID format' });

  const b64 = sessionId.replace(/^yobbyx:~/, '');
  let sessionFiles;
  try {
    sessionFiles = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch {
    return res.status(400).json({ error: 'Invalid base64 in session ID' });
  }

  // Find owner
  let ownerJid = null;
  if (sessionFiles['creds.json']) {
    try {
      const creds = JSON.parse(Buffer.from(sessionFiles['creds.json'], 'base64').toString('utf-8'));
      if (creds.me && creds.me.id) ownerJid = creds.me.id;
    } catch {}
  }
  const ownerNumber = ownerJid ? ownerJid.split(':')[0].split('@')[0] : 'unknown';
  const botId = 'bot-' + (ownerNumber !== 'unknown' ? ownerNumber : Date.now());
  const pm2Name = 'snuggle-x-' + botId;

  // Write session files to a folder
  const sessionDir = path.join(SESSIONS_DIR, botId);
  fs.mkdirSync(sessionDir, { recursive: true });
  for (const [name, b64content] of Object.entries(sessionFiles)) {
    const fp = path.join(sessionDir, name);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, Buffer.from(b64content, 'base64'));
  }

  // Start with pm2 — bot.js is in ./bot/bot.js
  exec(`pm2 start bot/bot.js --name "${pm2Name}" -- "${sessionId}"`, { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: 'pm2 start failed', details: stderr });
    }
    bots.set(botId, {
      id: botId,
      sessionId: sessionId.slice(0, 30) + '...',
      ownerNumber,
      pm2Name,
      status: 'starting',
      label: label || `${ownerNumber}`,
      startedAt: new Date().toISOString(),
    });
    res.json({ ok: true, botId, pm2Name, ownerNumber });
  });
});

// === Stop bot ===
app.post('/api/stop/:botId', auth, (req, res) => {
  const bot = bots.get(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  exec(`pm2 delete "${bot.pm2Name}"`, (err) => {
    bots.delete(req.params.botId);
    res.json({ ok: true });
  });
});

// === Bot status ===
app.get('/api/bot/:botId/status', auth, (req, res) => {
  const bot = bots.get(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  exec(`pm2 describe "${bot.pm2Name}"`, (err, stdout) => {
    res.json({ status: stdout, pid: getBotPid(bot.pm2Name) });
  });
});

function getBotPid(pm2Name) {
  try {
    const out = execSync(`pm2 jlist 2>/dev/null`, { encoding: 'utf-8' });
    const list = JSON.parse(out);
    const proc = list.find(p => p.name === pm2Name);
    return proc ? proc.pid : null;
  } catch { return null; }
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'snuggle-x-dashboard' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`[Snuggle X Dashboard] running on port ${PORT}`));
