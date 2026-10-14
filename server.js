const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');
const run = util.promisify(execFile);
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');

const PORT = process.env.PORT || 3000;
const BOT_API_KEY = process.env.BOT_API_KEY || 'change-me-too';
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'localhost';
const IMAGE = process.env.VPS_IMAGE || 'rastasheep/ubuntu-sshd:18.04';
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123'; // change this in production
const D = process.env;

const db = new Database('panel.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, hash TEXT, role TEXT DEFAULT 'user', discord_id TEXT);
CREATE TABLE IF NOT EXISTS admin_requests(id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT DEFAULT 'pending', at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY, name TEXT, cpu INTEGER, ram INTEGER, disk INTEGER);
CREATE TABLE IF NOT EXISTS vps(id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, cpu INTEGER, ram INTEGER, disk INTEGER, status TEXT, ssh_port INTEGER, root_pw TEXT);
CREATE TABLE IF NOT EXISTS forwards(id INTEGER PRIMARY KEY, vps_id INTEGER, host_port INTEGER, container_port INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS os(id INTEGER PRIMARY KEY, name TEXT, icon TEXT, image TEXT);
CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT, read INTEGER DEFAULT 0, at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
if (!db.prepare('SELECT 1 FROM plans').get()) {
  const ins = db.prepare('INSERT INTO plans(name,cpu,ram,disk) VALUES(?,?,?,?)');
  ins.run('Starter', 1, 1, 10); ins.run('Standard', 2, 2, 20); ins.run('Pro', 4, 4, 40);
}

for (const sql of ['ALTER TABLE vps ADD COLUMN expires_at TEXT', 'ALTER TABLE vps ADD COLUMN os TEXT', 'ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0', 'ALTER TABLE users ADD COLUMN theme TEXT']) { try { db.exec(sql); } catch (e) {} }
const DEF = { site_name: 'LightCloud', max_vps: '2', expiry_days: '30', registration: 'on', maintenance: 'off', maintenance_msg: 'We are doing maintenance. Back soon.', port_limit: '200' };
const getS = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : DEF[k]; };
const setS = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const log = (uid, text) => db.prepare('INSERT INTO logs(user_id,text) VALUES(?,?)').run(uid || null, text);
if (!db.prepare("SELECT 1 FROM settings WHERE key='bot_api_key'").get()) setS('bot_api_key', process.env.BOT_API_KEY || crypto.randomBytes(16).toString('hex'));
if (!db.prepare('SELECT 1 FROM os').get()) db.prepare('INSERT INTO os(name,icon,image) VALUES(?,?,?)').run('Ubuntu 18.04', '🟠', IMAGE);

// ---------- VPS driver (Docker). Swap these functions for LXD/Proxmox later ----------
const docker = (...a) => run('docker', a);
function nextPort() {
  const r = db.prepare('SELECT MAX(ssh_port) m FROM vps').get();
  return Math.max(20000, (r.m || 19999) + 1);
}
async function createVps(userId, name, plan, image, osName) {
  const pw = crypto.randomBytes(9).toString('base64url');
  const port = nextPort();
  const id = db.prepare("INSERT INTO vps(user_id,name,cpu,ram,disk,status,ssh_port,root_pw,expires_at,os) VALUES(?,?,?,?,?,?,?,?,datetime('now',?),?)")
    .run(userId, name, plan.cpu, plan.ram, plan.disk, 'creating', port, pw, '+' + (+getS('expiry_days') || 30) + ' days', osName || 'Ubuntu').lastInsertRowid;
  try {
    await docker('run', '-d', '--name', 'vps-' + id, '--cpus', String(plan.cpu), '--memory', plan.ram + 'g', '-p', port + ':22', image || IMAGE);
    await run('docker', ['exec', '-e', 'P=' + pw, 'vps-' + id, 'sh', '-c', 'echo "root:$P" | chpasswd']);
    db.prepare("UPDATE vps SET status='running' WHERE id=?").run(id);
    note(userId, `VPS "${name}" is ready.`);
  } catch (e) {
    db.prepare("UPDATE vps SET status='error' WHERE id=?").run(id);
    throw e;
  }
  return { id, port, pw };
}
const note = (uid, text) => db.prepare('INSERT INTO notes(user_id,text) VALUES(?,?)').run(uid, text);

// ---------- App ----------
const app = express();
app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-secret', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax' } }));
app.use(express.static('public'));
app.use('/api', (req, res, next) => {
  if (getS('maintenance') !== 'on' || ['/login', '/register', '/logout', '/me'].includes(req.path) || req.path.startsWith('/admin')) return next();
  const u = req.session.uid && db.prepare('SELECT role FROM users WHERE id=?').get(req.session.uid);
  if (u && u.role === 'admin') return next();
  res.status(503).json({ error: getS('maintenance_msg') });
});

const auth = (req, res, next) => {
  if (!req.session.uid) return res.status(401).json({ error: 'Log in first.' });
  const u = db.prepare('SELECT banned FROM users WHERE id=?').get(req.session.uid);
  if (!u || u.banned) return req.session.destroy(() => res.status(403).json({ error: 'This account is banned.' }));
  next();
};
const admin = (req, res, next) => {
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.uid);
  return u && u.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only.' });
};
const own = (req) => db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.post('/api/register', (req, res) => {
  if (getS('registration') !== 'on') return res.status(403).json({ error: 'Registration is closed right now.' });
  const { email, username, password } = req.body || {};
  if (!EMAIL_RE.test(email || '')) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '') || (password || '').length < 8)
    return res.status(400).json({ error: 'Username 3-20 letters/numbers, password 8+ characters.' });
  const em = email.toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE username=? OR email=?').get(username, em))
    return res.status(409).json({ error: 'That username or email is already registered.' });
  const id = db.prepare('INSERT INTO users(username,email,hash) VALUES(?,?,?)').run(username, em, bcrypt.hashSync(password, 10)).lastInsertRowid;
  req.session.uid = id;
  note(id, 'Welcome to the panel!');
  res.json({ ok: true });
});
app.post('/api/login', (req, res) => {
  const { login, password } = req.body || {};
  const l = String(login || '').trim();
  const u = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(l, l.toLowerCase());
  if (!u || !u.hash || !bcrypt.compareSync(password || '', u.hash)) return res.status(401).json({ error: 'Wrong email/username or password.' });
  if (u.banned) return res.status(403).json({ error: 'This account is banned.' });
  req.session.uid = u.id;
  if (req.body.remember) req.session.cookie.maxAge = 30 * 864e5;
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', auth, (req, res) => {
  const u = db.prepare('SELECT id,username,email,role,discord_id,theme FROM users WHERE id=?').get(req.session.uid);
  u.unread = db.prepare('SELECT COUNT(*) c FROM notes WHERE user_id=? AND read=0').get(u.id).c;
  const r = db.prepare('SELECT status FROM admin_requests WHERE user_id=? ORDER BY id DESC').get(u.id);
  u.adminRequest = r ? r.status : null;
  u.maintenance = getS('maintenance') === 'on';
  u.site_name = getS('site_name');
  res.json(u);
});

// ---------- Discord login ----------
app.get('/auth/discord', (req, res) => {
  if (!D.DISCORD_CLIENT_ID) return res.status(500).send('Discord login is not set up yet.');
  req.session.state = crypto.randomBytes(16).toString('hex');
  res.redirect('https://discord.com/oauth2/authorize?' + new URLSearchParams({
    client_id: D.DISCORD_CLIENT_ID, redirect_uri: D.DISCORD_REDIRECT_URI, response_type: 'code', scope: 'identify email', state: req.session.state }));
});
app.get('/auth/discord/callback', async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.state) throw new Error('bad state');
    const t = await (await fetch('https://discord.com/api/oauth2/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: D.DISCORD_CLIENT_ID, client_secret: D.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: req.query.code, redirect_uri: D.DISCORD_REDIRECT_URI }) })).json();
    const d = await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
    if (!d.id) throw new Error('no id');
    const email = d.verified && d.email ? d.email.toLowerCase() : null;
    let u = db.prepare('SELECT * FROM users WHERE discord_id=?').get(d.id);
    if (!u && email) u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (u && !u.discord_id) db.prepare('UPDATE users SET discord_id=? WHERE id=?').run(d.id, u.id);
    if (!u) {
      const base = String(d.username).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16) || 'user';
      let n = base, i = 0;
      while (db.prepare('SELECT 1 FROM users WHERE username=?').get(n)) n = base + (++i);
      const id = db.prepare('INSERT INTO users(username,email,discord_id) VALUES(?,?,?)').run(n, email, d.id).lastInsertRowid;
      note(id, 'Welcome to the panel!');
      u = { id };
    }
    req.session.uid = u.id;
    res.redirect('/');
  } catch (e) { res.redirect('/login.html?error=discord'); }
});

// ---------- Admin: key + verification ----------
// 1st person to use the key becomes admin. After that, the key alone is not enough:
// the person must type their own username and an existing admin must approve them.
const fails = {};
app.post('/api/admin/unlock', auth, (req, res) => {
  const uid = req.session.uid, f = fails[uid] || { n: 0, until: 0 };
  if (Date.now() < f.until) return res.status(429).json({ error: 'Too many wrong keys. Try again in 15 minutes.' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  if (u.role === 'admin') return res.json({ status: 'admin' });
  const { key, username } = req.body || {};
  if (username !== u.username) return res.status(400).json({ error: 'Type your own username exactly as it appears on your account.' });
  const a = Buffer.from(String(key || '')), b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    f.n++; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 15 * 60000; }
    fails[uid] = f;
    return res.status(403).json({ error: 'Wrong admin key.' });
  }
  fails[uid] = { n: 0, until: 0 };
  if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(uid);
    return res.json({ status: 'admin' });
  }
  if (!db.prepare("SELECT 1 FROM admin_requests WHERE user_id=? AND status='pending'").get(uid)) {
    db.prepare('INSERT INTO admin_requests(user_id) VALUES(?)').run(uid);
    db.prepare("SELECT id FROM users WHERE role='admin'").all().forEach(x => note(x.id, `${u.username} asked for admin access. Review it in Admin.`));
  }
  res.json({ status: 'pending' });
});
app.get('/api/admin/requests', auth, admin, (req, res) => res.json(db.prepare(
  "SELECT r.id,r.at,u.username,u.email,u.discord_id FROM admin_requests r JOIN users u ON u.id=r.user_id WHERE r.status='pending' ORDER BY r.id").all()));
app.post('/api/admin/requests/:id/:decision', auth, admin, (req, res) => {
  const r = db.prepare("SELECT * FROM admin_requests WHERE id=? AND status='pending'").get(req.params.id);
  const ok = req.params.decision === 'approve';
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (!ok && req.params.decision !== 'deny') return res.status(400).json({ error: 'Unknown decision.' });
  db.prepare('UPDATE admin_requests SET status=? WHERE id=?').run(ok ? 'approved' : 'denied', r.id);
  if (ok) db.prepare("UPDATE users SET role='admin' WHERE id=?").run(r.user_id);
  note(r.user_id, ok ? 'Your admin access was approved.' : 'Your admin request was denied.');
  res.json({ ok: true });
});
app.get('/api/admin/users', auth, admin, (req, res) => res.json(db.prepare(
  'SELECT u.id,u.username,u.email,u.role,u.banned,u.discord_id,(SELECT COUNT(*) FROM vps WHERE user_id=u.id) vps FROM users u ORDER BY u.id').all()));

app.post('/api/profile/theme', auth, (req, res) => {
  let t;
  try { t = JSON.parse((req.body || {}).theme); } catch (e) { return res.status(400).json({ error: 'Bad theme.' }); }
  const clean = { id: /^[a-z]{2,20}$/.test(t.id || '') ? t.id : 'neon' };
  if (/^#[0-9a-fA-F]{6}$/.test(t.accent || '')) clean.accent = t.accent;
  db.prepare('UPDATE users SET theme=? WHERE id=?').run(JSON.stringify(clean), req.session.uid);
  res.json({ ok: true });
});
app.post('/api/profile/password', auth, (req, res) => {
  const { current, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.uid);
  if ((password || '').length < 8) return res.status(400).json({ error: 'New password must be 8+ characters.' });
  if (u.hash && !bcrypt.compareSync(current || '', u.hash)) return res.status(403).json({ error: 'Current password is wrong.' });
  db.prepare('UPDATE users SET hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), u.id);
  note(u.id, 'Your password was changed.');
  res.json({ ok: true });
});
app.post('/api/profile/email', auth, (req, res) => {
  const em = String((req.body || {}).email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(em)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(em, req.session.uid)) return res.status(409).json({ error: 'That email is already used.' });
  db.prepare('UPDATE users SET email=? WHERE id=?').run(em, req.session.uid);
  res.json({ ok: true });
});
app.get('/api/dashboard', auth, (req, res) => {
  const r = db.prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(status='running'),0) running, COALESCE(SUM(status='suspended'),0) suspended,
    COALESCE(SUM(cpu),0) cpu, COALESCE(SUM(ram),0) ram, COALESCE(SUM(disk),0) disk
    FROM vps WHERE user_id=?`).get(req.session.uid);
  res.json(r);
});
app.get('/api/vps', auth, (req, res) =>
  res.json(db.prepare('SELECT * FROM vps WHERE user_id=? ORDER BY id DESC').all(req.session.uid).map(v => ({ ...v, host: PUBLIC_HOST }))));
app.post('/api/vps/:id/:action', auth, async (req, res) => {
  const v = own(req);
  if (!v) return res.status(404).json({ error: 'VPS not found.' });
  if (v.status === 'suspended') return res.status(403).json({ error: 'This VPS is suspended.' });
  try {
    const a = req.params.action;
    if (a === 'start') { await docker('start', 'vps-' + v.id); db.prepare("UPDATE vps SET status='running' WHERE id=?").run(v.id); }
    else if (a === 'stop') { await docker('stop', 'vps-' + v.id); db.prepare("UPDATE vps SET status='stopped' WHERE id=?").run(v.id); }
    else if (a === 'restart') { await docker('restart', 'vps-' + v.id); db.prepare("UPDATE vps SET status='running' WHERE id=?").run(v.id); }
    else return res.status(400).json({ error: 'Unknown action.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Docker error: ' + e.message.split('\n')[0] }); }
});
app.delete('/api/vps/:id', auth, async (req, res) => {
  const v = own(req);
  if (!v) return res.status(404).json({ error: 'VPS not found.' });
  try { await docker('rm', '-f', 'vps-' + v.id); } catch (e) {}
  dropForwards(v.id);
  db.prepare('DELETE FROM vps WHERE id=?').run(v.id);
  res.json({ ok: true });
});

// ---------- Port forwards: a real TCP proxy per rule (public port -> VPS port) ----------
const proxies = new Map();
const containerIp = async id => (await docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'vps-' + id)).stdout.trim();
function startProxy(f) {
  return new Promise((resolve, reject) => {
    if (proxies.has(f.id)) return resolve();
    const srv = net.createServer(async c => {
      const end = () => c.destroy();
      c.on('error', end);
      try {
        const ip = await containerIp(f.vps_id);
        if (!ip) return end();
        const t = net.connect(f.container_port, ip);
        t.on('error', end); t.on('close', end); c.on('close', () => t.destroy());
        c.pipe(t); t.pipe(c);
      } catch (e) { end(); }
    });
    srv.once('error', e => { proxies.delete(f.id); reject(e); });
    srv.listen(f.host_port, '0.0.0.0', () => { srv.removeAllListeners('error'); srv.on('error', () => {}); resolve(); });
    proxies.set(f.id, srv);
  });
}
function stopProxy(id) { const x = proxies.get(id); if (x) { x.close(); proxies.delete(id); } }
function dropForwards(vpsId) {
  db.prepare('SELECT id FROM forwards WHERE vps_id=?').all(vpsId).forEach(f => stopProxy(f.id));
  db.prepare('DELETE FROM forwards WHERE vps_id=?').run(vpsId);
}
db.prepare('SELECT * FROM forwards').all().forEach(f => startProxy(f).catch(e => log(null, `Forward ${f.host_port} could not start: ${e.code}`)));

app.get('/api/forwards', auth, (req, res) => res.json(db.prepare(
  'SELECT f.*, v.name vps_name FROM forwards f JOIN vps v ON v.id=f.vps_id WHERE v.user_id=?').all(req.session.uid).map(f => ({ ...f, host: PUBLIC_HOST }))));
app.post('/api/forwards', auth, async (req, res) => {
  const { vps_id, host_port, container_port } = req.body || {};
  const v = db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(vps_id, req.session.uid);
  const hp = +host_port, cp = +container_port;
  if (!v || !(hp >= 1024 && hp <= 65535) || !(cp >= 1 && cp <= 65535)) return res.status(400).json({ error: 'Pick a VPS, a public port 1024-65535 and a VPS port.' });
  if (hp === +PORT) return res.status(409).json({ error: 'That port is used by the panel.' });
  if (db.prepare('SELECT COUNT(*) c FROM forwards f JOIN vps x ON x.id=f.vps_id WHERE x.user_id=?').get(req.session.uid).c >= 10)
    return res.status(403).json({ error: 'Forward limit reached (10 per user).' });
  if (db.prepare('SELECT 1 FROM forwards WHERE host_port=?').get(hp) || db.prepare('SELECT 1 FROM vps WHERE ssh_port=?').get(hp))
    return res.status(409).json({ error: 'That port is already in use.' });
  const id = db.prepare('INSERT INTO forwards(vps_id,host_port,container_port) VALUES(?,?,?)').run(v.id, hp, cp).lastInsertRowid;
  try { await startProxy({ id, vps_id: v.id, host_port: hp, container_port: cp }); }
  catch (e) {
    db.prepare('DELETE FROM forwards WHERE id=?').run(id);
    return res.status(409).json({ error: 'The server could not open that port (' + (e.code || 'error') + '). Try another.' });
  }
  log(req.session.uid, `Forward ${hp} to VPS ${v.id}:${cp}`);
  res.json({ ok: true });
});
app.delete('/api/forwards/:id', auth, (req, res) => {
  const f = db.prepare('SELECT f.id FROM forwards f JOIN vps v ON v.id=f.vps_id WHERE f.id=? AND v.user_id=?').get(req.params.id, req.session.uid);
  if (f) { stopProxy(f.id); db.prepare('DELETE FROM forwards WHERE id=?').run(f.id); }
  res.json({ ok: true });
});

app.get('/api/plans', auth, (req, res) => res.json(db.prepare('SELECT * FROM plans').all()));
app.post('/api/shop/:planId/claim', auth, async (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found.' });
  const count = db.prepare('SELECT COUNT(*) c FROM vps WHERE user_id=?').get(req.session.uid).c;
  const max = +getS('max_vps') || 2;
  if (count >= max) return res.status(403).json({ error: `VPS limit reached (${max} per user).` });
  try {
    const o = db.prepare('SELECT * FROM os WHERE id=?').get((req.body || {}).osId) || db.prepare('SELECT * FROM os').get();
    await createVps(req.session.uid, plan.name + ' VPS', plan, o.image, o.name);
    log(req.session.uid, `Claimed ${plan.name} VPS`);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: 'Could not create VPS: ' + e.message.split('\n')[0] }); }
});
// ---------- Admin: dashboard, VPS, users, settings, backups ----------
let lastCpu = os.cpus().map(c => ({ ...c.times }));
function cpuPercent() {
  const now = os.cpus().map(c => ({ ...c.times }));
  let idle = 0, total = 0;
  now.forEach((c, i) => { const p = lastCpu[i] || c; for (const k in c) { const d = c[k] - (p[k] || 0); total += d; if (k === 'idle') idle += d; } });
  lastCpu = now;
  return total ? Math.round(1000 * (1 - idle / total)) / 10 : 0;
}
function health() {
  const tot = os.totalmem(), free = os.freemem();
  let disk = { total: 0, free: 0 };
  try { const st = fs.statfsSync('/'); disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize }; } catch (e) {}
  return { cpu: cpuPercent(), ram: { used: tot - free, total: tot }, disk: { used: disk.total - disk.free, total: disk.total }, uptime: os.uptime() };
}
app.get('/api/admin/stats', auth, admin, (req, res) => {
  const q = t => db.prepare(t).get().c;
  const vpsN = q('SELECT COUNT(*) c FROM vps');
  res.json({ users: q('SELECT COUNT(*) c FROM users'), vps: vpsN, running: q("SELECT COUNT(*) c FROM vps WHERE status='running'"),
    suspended: q("SELECT COUNT(*) c FROM vps WHERE status='suspended'"), ports: vpsN + q('SELECT COUNT(*) c FROM forwards'),
    portLimit: +getS('port_limit') || 200, health: health(), node: { name: 'Local Node', host: os.hostname(), cpus: os.cpus().length } });
});
const vpsAll = 'SELECT v.*, u.username owner FROM vps v LEFT JOIN users u ON u.id=v.user_id';
app.get('/api/admin/vps', auth, admin, (req, res) => res.json(db.prepare(vpsAll + ' ORDER BY v.id DESC').all()));
app.get('/api/admin/expiring', auth, admin, (req, res) => res.json(db.prepare(
  vpsAll + " WHERE v.expires_at IS NOT NULL AND v.expires_at < datetime('now','+7 days') ORDER BY v.expires_at").all()));
app.post('/api/admin/vps', auth, admin, async (req, res) => {
  const { username, planId, osId } = req.body || {};
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(username || '');
  const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(planId);
  const o = db.prepare('SELECT * FROM os WHERE id=?').get(osId) || db.prepare('SELECT * FROM os').get();
  if (!u || !plan || !o) return res.status(400).json({ error: 'Pick an existing username, plan and OS.' });
  try { await createVps(u.id, plan.name + ' VPS', plan, o.image, o.name); log(req.session.uid, `Created VPS for ${username}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Could not create VPS: ' + e.message.split('\n')[0] }); }
});
app.post('/api/admin/vps/:id/:action', auth, admin, async (req, res) => {
  const v = db.prepare('SELECT * FROM vps WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'VPS not found.' });
  const a = req.params.action;
  try {
    if (a === 'suspend') { await docker('stop', 'vps-' + v.id).catch(() => {}); db.prepare("UPDATE vps SET status='suspended' WHERE id=?").run(v.id); note(v.user_id, `VPS "${v.name}" was suspended by an admin.`); }
    else if (a === 'unsuspend') { await docker('start', 'vps-' + v.id); db.prepare("UPDATE vps SET status='running' WHERE id=?").run(v.id); note(v.user_id, `VPS "${v.name}" is active again.`); }
    else if (a === 'extend') { db.prepare("UPDATE vps SET expires_at=datetime(MAX(COALESCE(expires_at,datetime('now')),datetime('now')),?) WHERE id=?").run('+' + (+getS('expiry_days') || 30) + ' days', v.id); note(v.user_id, `VPS "${v.name}" was extended.`); }
    else return res.status(400).json({ error: 'Unknown action.' });
    log(req.session.uid, `${a} VPS ${v.id}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Docker error: ' + e.message.split('\n')[0] }); }
});
app.delete('/api/admin/vps/:id', auth, admin, async (req, res) => {
  await docker('rm', '-f', 'vps-' + req.params.id).catch(() => {});
  dropForwards(req.params.id);
  db.prepare('DELETE FROM vps WHERE id=?').run(req.params.id);
  log(req.session.uid, `Deleted VPS ${req.params.id}`);
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/:action', auth, admin, (req, res) => {
  const id = +req.params.id;
  if (id === req.session.uid) return res.status(400).json({ error: 'You cannot change your own account here.' });
  const m = { ban: ['banned', 1], unban: ['banned', 0], 'make-admin': ['role', 'admin'], 'remove-admin': ['role', 'user'] }[req.params.action];
  if (!m) return res.status(400).json({ error: 'Unknown action.' });
  db.prepare(`UPDATE users SET ${m[0]}=? WHERE id=?`).run(m[1], id);
  log(req.session.uid, `${req.params.action} user ${id}`);
  res.json({ ok: true });
});
app.delete('/api/admin/plans/:id', auth, admin, (req, res) => { db.prepare('DELETE FROM plans WHERE id=?').run(req.params.id); res.json({ ok: true }); });
app.get('/api/os', auth, (req, res) => res.json(db.prepare('SELECT * FROM os').all()));
app.post('/api/admin/os', auth, admin, (req, res) => {
  const { name, icon, image } = req.body || {};
  if (!name || !/^[\w./:-]+$/.test(image || '')) return res.status(400).json({ error: 'Name and a valid Docker image (like ubuntu:22.04) are required.' });
  db.prepare('INSERT INTO os(name,icon,image) VALUES(?,?,?)').run(name, icon || '💻', image);
  res.json({ ok: true });
});
app.delete('/api/admin/os/:id', auth, admin, (req, res) => {
  if (db.prepare('SELECT COUNT(*) c FROM os').get().c <= 1) return res.status(400).json({ error: 'Keep at least one OS.' });
  db.prepare('DELETE FROM os WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
const KEYS = ['site_name', 'max_vps', 'expiry_days', 'registration', 'maintenance', 'maintenance_msg', 'port_limit'];
app.get('/api/admin/settings', auth, admin, (req, res) => res.json(Object.fromEntries(KEYS.map(k => [k, getS(k)]))));
app.post('/api/admin/settings', auth, admin, (req, res) => {
  for (const k of KEYS) if (req.body && req.body[k] !== undefined) setS(k, String(req.body[k]).slice(0, 200));
  log(req.session.uid, 'Changed settings');
  res.json({ ok: true });
});
app.get('/api/admin/api-key', auth, admin, (req, res) => res.json({ key: getS('bot_api_key') }));
app.post('/api/admin/api-key', auth, admin, (req, res) => {
  setS('bot_api_key', crypto.randomBytes(16).toString('hex'));
  log(req.session.uid, 'Regenerated API key');
  res.json({ key: getS('bot_api_key') });
});
app.get('/api/admin/logs', auth, admin, (req, res) => res.json(db.prepare(
  'SELECT l.*, u.username FROM logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 100').all()));
app.get('/api/admin/system', auth, admin, async (req, res) => {
  let dv = 'not found';
  try { dv = (await docker('--version')).stdout.trim(); } catch (e) {}
  res.json({ platform: os.platform() + ' ' + os.release(), arch: os.arch(), host: os.hostname(), cpus: os.cpus().length,
    cpuModel: (os.cpus()[0] || {}).model, node: process.version, docker: dv, uptime: os.uptime(), panelUptime: process.uptime(), dbSize: fs.statSync('panel.db').size });
});
const BK = path.join(__dirname, 'backups');
fs.mkdirSync(BK, { recursive: true });
const bkOk = n => /^panel-[\w-]+\.db$/.test(n);
app.get('/api/admin/backups', auth, admin, (req, res) => res.json(fs.readdirSync(BK).filter(bkOk).map(n => {
  const st = fs.statSync(path.join(BK, n)); return { name: n, size: st.size, at: st.mtime };
}).sort((a, b) => b.at - a.at)));
app.post('/api/admin/backups', auth, admin, async (req, res) => {
  const n = 'panel-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db';
  await db.backup(path.join(BK, n));
  log(req.session.uid, 'Created backup ' + n);
  res.json({ ok: true });
});
app.get('/api/admin/backups/:name', auth, admin, (req, res) => bkOk(req.params.name) ? res.download(path.join(BK, req.params.name)) : res.status(400).end());
app.delete('/api/admin/backups/:name', auth, admin, (req, res) => {
  if (bkOk(req.params.name)) fs.rmSync(path.join(BK, req.params.name), { force: true });
  res.json({ ok: true });
});
app.post('/api/admin/emergency', auth, admin, async (req, res) => {
  const list = db.prepare("SELECT id FROM vps WHERE status='running'").all();
  await Promise.all(list.map(v => docker('stop', 'vps-' + v.id).catch(() => {})));
  db.prepare("UPDATE vps SET status='stopped' WHERE status='running'").run();
  log(req.session.uid, `Emergency stop: ${list.length} VPS`);
  res.json({ stopped: list.length });
});

app.post('/api/admin/plans', auth, admin, (req, res) => {
  const { name, cpu, ram, disk } = req.body || {};
  if (!name || !(cpu > 0) || !(ram > 0) || !(disk > 0)) return res.status(400).json({ error: 'Name, CPU, RAM and disk are required.' });
  db.prepare('INSERT INTO plans(name,cpu,ram,disk) VALUES(?,?,?,?)').run(name, +cpu, +ram, +disk);
  res.json({ ok: true });
});
app.get('/api/notes', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM notes WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.session.uid);
  db.prepare('UPDATE notes SET read=1 WHERE user_id=?').run(req.session.uid);
  res.json(rows);
});

// ---------- Bot API: the Discord bot calls this, then DMs the returned access ----------
app.post('/api/bot/deploy', async (req, res) => {
  if (req.get('x-api-key') !== getS('bot_api_key')) return res.status(401).json({ error: 'Bad API key.' });
  const { discordId, planId } = req.body || {};
  const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(planId);
  if (!discordId || !plan) return res.status(400).json({ error: 'discordId and a valid planId are required.' });
  let u = db.prepare('SELECT * FROM users WHERE discord_id=?').get(discordId);
  let panelPassword = null;
  if (!u) {
    panelPassword = crypto.randomBytes(9).toString('base64url');
    const username = 'user' + discordId.slice(-6);
    const id = db.prepare('INSERT INTO users(username,hash,discord_id) VALUES(?,?,?)').run(username, bcrypt.hashSync(panelPassword, 10), discordId).lastInsertRowid;
    u = { id, username };
  }
  try {
    const o = db.prepare('SELECT * FROM os').get();
    const v = await createVps(u.id, plan.name + ' VPS', plan, o.image, o.name);
    res.json({ panelUser: u.username, panelPassword, host: PUBLIC_HOST, sshPort: v.port, sshUser: 'root', sshPassword: v.pw, plan: plan.name });
  } catch (e) { res.status(500).json({ error: 'Could not create VPS: ' + e.message.split('\n')[0] }); }
});

// Hourly: suspend VPS whose expiry date has passed
setInterval(async () => {
  const due = db.prepare("SELECT * FROM vps WHERE status IN ('running','stopped') AND expires_at IS NOT NULL AND expires_at < datetime('now')").all();
  for (const v of due) {
    try { await docker('stop', 'vps-' + v.id); } catch (e) {}
    db.prepare("UPDATE vps SET status='suspended' WHERE id=?").run(v.id);
    note(v.user_id, `VPS "${v.name}" expired and was suspended. Ask an admin to extend it.`);
    log(null, `VPS ${v.id} expired`);
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log('Panel running on :' + PORT));
