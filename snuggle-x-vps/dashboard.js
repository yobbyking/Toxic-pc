// Snuggle X Admin Dashboard — runs on VPS port 2002
// Admin can: see all session IDs, deploy bots, view running bots, stop bots

const express = require('express');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
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
    ...getBotInfo(b.pm2Name),
  }));
  res.json({ bots: list });
});

// === Deploy a bot from a session ID ===
app.post('/api/deploy', auth, async (req, res) => {
  const { sessionId, label } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  if (!sessionId.startsWith('yobbyx:~')) return res.status(400).json({ error: 'Invalid session ID format' });

  const b64 = sessionId.replace(/^yobbyx:~/, '');
  let sessionFiles;

  // === Check if it's a short ID (12 hex chars), a URL, or base64 (old format) ===
  if (/^[a-f0-9]{12}$/.test(b64)) {
    // New short format: fetch from the pairing site
    const PAIRING_SITE = process.env.PAIRING_SITE_URL || 'https://snuggle-x-pair.onrender.com';
    const fetchUrl = `${PAIRING_SITE}/session/${b64}`;
    console.log(`[DEPLOY] Fetching session from: ${fetchUrl}`);
    try {
      const https = require('https');
      const gzipped = await new Promise((resolve, reject) => {
        https.get(fetchUrl, { timeout: 30000 }, (resp) => {
          if (resp.statusCode !== 200) return reject(new Error(`HTTP ${resp.statusCode}`));
          const chunks = [];
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => resolve(Buffer.concat(chunks)));
          resp.on('error', reject);
        }).on('error', reject);
      });
      console.log(`[DEPLOY] Downloaded ${gzipped.length} bytes`);
      const json = zlib.gunzipSync(gzipped).toString('utf-8');
      sessionFiles = JSON.parse(json);
    } catch (e) {
      return res.status(400).json({ error: `Failed to fetch session: ${e.message}` });
    }
  } else if (b64.startsWith('http')) {
    // URL format: fetch the gzipped session from the URL
    console.log(`[DEPLOY] Fetching session from URL: ${b64}`);
    try {
      const https = require('https');
      const fetchUrl = (url) => new Promise((resolve, reject) => {
        https.get(url, { timeout: 30000 }, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            return fetchUrl(resp.headers.location).then(resolve).catch(reject);
          }
          if (resp.statusCode !== 200) return reject(new Error(`HTTP ${resp.statusCode}`));
          const chunks = [];
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => resolve(Buffer.concat(chunks)));
          resp.on('error', reject);
        }).on('error', reject);
      });
      const gzipped = await fetchUrl(b64);
      const json = zlib.gunzipSync(gzipped).toString('utf-8');
      sessionFiles = JSON.parse(json);
    } catch (e) {
      return res.status(400).json({ error: `Failed to fetch session from URL: ${e.message}` });
    }
  } else {
    // Old format: decode from base64
    try {
      let standardB64 = b64.replace(/-/g, '+').replace(/_/g, '/');
      standardB64 += '='.repeat((4 - standardB64.length % 4) % 4);
      try {
        const gzipped = Buffer.from(standardB64, 'base64');
        const json = zlib.gunzipSync(gzipped).toString('utf-8');
        sessionFiles = JSON.parse(json);
      } catch (e) {
        sessionFiles = JSON.parse(Buffer.from(standardB64, 'base64').toString('utf-8'));
      }
    } catch {
      return res.status(400).json({ error: 'Invalid session ID — could not decode' });
    }
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

  // Start with pm2 — pass the session folder path (not the long session ID)
  exec(`pm2 start bot/bot.js --name "${pm2Name}" -- "${sessionDir}"`, { cwd: __dirname }, (err, stdout, stderr) => {
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

// === Bot logs ===
app.get('/api/bot/:botId/logs', auth, (req, res) => {
  const bot = bots.get(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  const lines = parseInt(req.query.lines) || 100;
  // Read the pm2 log file directly
  const logFile = `/root/.pm2/logs/${bot.pm2Name}-out.log`;
  exec(`tail -n ${lines} "${logFile}" 2>&1`, (err, stdout) => {
    res.json({ logs: stdout || '' });
  });
});

// === All bot logs (combined) — for the logs panel ===
app.get('/api/logs', auth, (req, res) => {
  const lines = parseInt(req.query.lines) || 200;
  // Get logs from all snuggle-x-bot-* processes
  exec(`tail -n ${lines} /root/.pm2/logs/snuggle-x-bot-*-out.log 2>&1 | tail -n ${lines}`, (err, stdout) => {
    const logs = (stdout || '').split('\n').filter(l => l.trim()).map(line => {
      // Try to extract timestamp + level
      let level = 'info';
      if (line.includes('[CMD]')) level = 'cmd';
      else if (line.includes('Connected')) level = 'success';
      else if (line.includes('ERROR') || line.includes('failed')) level = 'error';
      else if (line.includes('Snuggle X Bot')) level = 'system';
      return { t: new Date().toISOString(), level, msg: line };
    });
    res.json({ logs });
  });
});

// === Live logs stream (for the panel — last N lines + keep polling) ===
app.get('/api/logs/raw', auth, (req, res) => {
  const lines = parseInt(req.query.lines) || 100;
  exec(`tail -n ${lines} /root/.pm2/logs/snuggle-x-bot-*-out.log 2>&1 | tail -n ${lines}`, (err, stdout) => {
    res.type('text/plain').send(stdout || '');
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

function getBotInfo(pm2Name) {
  try {
    const out = execSync(`pm2 jlist 2>/dev/null`, { encoding: 'utf-8' });
    const list = JSON.parse(out);
    const proc = list.find(p => p.name === pm2Name);
    if (!proc) return { pid: null, uptime: null, memory: null };
    return {
      pid: proc.pid,
      uptime: proc.pm2_env && proc.pm2_env.pm_uptime ? formatUptime((Date.now() - proc.pm2_env.pm_uptime) / 1000) : null,
      memory: proc.monit ? `${(proc.monit.memory / 1024 / 1024).toFixed(1)} MB` : null,
    };
  } catch { return { pid: null, uptime: null, memory: null }; }
}

function formatUptime(sec) {
  if (!sec || sec < 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'snuggle-x-dashboard' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`[Snuggle X Dashboard] running on port ${PORT}`));
