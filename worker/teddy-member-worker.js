// Teddy Member API — Cloudflare Worker + D1
// v1.0 (2026-11-07)
//
// Bindings (Worker → Settings):
//   D1 database binding  DB
//   Secret  PEPPER          random string ≥ 32 chars (never change after members exist)
//   Secret  ADMIN_PASSWORD  owner password, ≥ 10 chars
//   Secret  STAFF_PASSWORD  (optional) maid password, ≥ 8 chars — can only top up / deduct
//   Text    ALLOWED_ORIGIN  e.g. https://phoneyjung.github.io  (comma-separated if several)

const VERSION = '1.0';
const SCHEMA_VERSION = '1';

const MEMBER_TTL = 60 * 60;          // member session 1 h
const ADMIN_TTL = 12 * 60 * 60;      // owner/staff session 12 h
const LOGIN_IP_LIMIT = [20, 15 * 60];       // 20 attempts / 15 min / IP
const LOGIN_ID_FAIL = [5, 15 * 60];         // 5 wrong PIN / 15 min / member id
const LOGIN_ID_FAIL_DAY = [15, 24 * 3600];  // 15 wrong PIN / 24 h / member id
const ADMIN_IP_LIMIT = [8, 15 * 60];        // 8 admin logins / 15 min / IP
const ADMIN_FAIL_ALL = [20, 60 * 60];       // 20 wrong admin passwords / hour (all IPs)
const API_IP_LIMIT = [600, 5 * 60];         // general API calls / 5 min / IP
const MAX_BODY = 512 * 1024;

const DEFAULT_SETTINGS = {
  promo: {
    name: 'เดือนปล่อยผี ยิ่งเติม ยิ่งคุ้ม!',
    start: '2026-10-01',
    end: '2026-10-31',
    tiers: [{ min: 100000, bp: 1000 }, { min: 150000, bp: 1500 }, { min: 200000, bp: 2000 }],
  },
  limits: { minTopup: 2000, maxTopup: 2000000, maxUse: 300000 }, // satang
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS members (
     id TEXT PRIMARY KEY, nickname TEXT NOT NULL DEFAULT '', gender TEXT NOT NULL DEFAULT '',
     pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1,
     status TEXT NOT NULL DEFAULT 'active', last_login INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS txns (
     id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL, type TEXT NOT NULL,
     amount INTEGER NOT NULL, bonus_bp INTEGER NOT NULL DEFAULT 0, delta INTEGER NOT NULL,
     branch TEXT, method TEXT, bank TEXT, note TEXT, occurred_at TEXT NOT NULL,
     created_at INTEGER NOT NULL, created_by TEXT NOT NULL, client_id TEXT UNIQUE,
     voided_at INTEGER, voided_by TEXT, void_reason TEXT)`,
  `CREATE INDEX IF NOT EXISTS txns_member ON txns(member_id, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     h TEXT PRIMARY KEY, kind TEXT NOT NULL, member_id TEXT, must_change INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT)`,
  `CREATE INDEX IF NOT EXISTS sessions_exp ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
     member_id TEXT, detail TEXT, ip TEXT)`,
  `CREATE INDEX IF NOT EXISTS audit_at ON audit(at)`,
  `INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '${SCHEMA_VERSION}')`,
];

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, code, msg, extra) { super(msg); this.status = status; this.code = code; this.extra = extra; }
}
const now = () => Math.floor(Date.now() / 1000);
const bkkDate = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const bkkStamp = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const enc = new TextEncoder();

function b64url(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randToken(n = 32) { const b = new Uint8Array(n); crypto.getRandomValues(b); return b64url(b); }
function randPin() {
  // 6-digit PIN from a CSPRNG, rejecting weak patterns
  for (;;) {
    const b = new Uint32Array(1); crypto.getRandomValues(b);
    if (b[0] >= 4294000000) continue; // avoid modulo bias
    const p = String(b[0] % 1000000).padStart(6, '0');
    if (!weakPin(p, '')) return p;
  }
}
async function sha256(s) { return b64url(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

let _hmacKey = null, _hmacFor = null;
async function hmacKey(env) {
  if (_hmacKey && _hmacFor === env.PEPPER) return _hmacKey;
  if (!env.PEPPER || env.PEPPER.length < 32) throw new HttpError(500, 'config', 'ยังไม่ได้ตั้งค่า PEPPER ใน Worker');
  _hmacKey = await crypto.subtle.importKey('raw', enc.encode(env.PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  _hmacFor = env.PEPPER;
  return _hmacKey;
}
async function hmac(env, msg) { return b64url(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(msg))); }
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
async function pinHash(env, salt, id, pin) { return hmac(env, `pin:${salt}:${id}:${pin}`); }

function weakPin(p, id) {
  if (!/^\d{6}$/.test(p)) return true;
  if (/^(\d)\1{5}$/.test(p)) return true;                  // 000000
  const d = p.split('').map(Number);
  let up = true, down = true;
  for (let i = 1; i < 6; i++) { if (d[i] !== d[i - 1] + 1) up = false; if (d[i] !== d[i - 1] - 1) down = false; }
  if (up || down) return true;                              // 123456 / 654321
  if (/^(\d\d)\1\1$/.test(p) || /^(\d{3})\1$/.test(p)) return true; // 121212 / 123123
  if (/^(\d)\1(\d)\2(\d)\3$/.test(p)) return true;         // 112233
  if (id && (p === id.slice(1) || p === id.slice(0, 6))) return true; // part of member number
  return false;
}

const reId = /^\d{7}$/;
const rePin = /^\d{6}$/;
const reDate = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;
const BRANCHES = ['teddy1', 'teddy2'];
const METHODS = ['transfer', 'cash'];

function str(v, max, name) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'bad', `ข้อมูล ${name} ไม่ถูกต้อง`);
  const s = v.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (s.length > max) throw new HttpError(400, 'bad', `${name} ยาวเกินไป`);
  return s;
}
function intIn(v, lo, hi, name) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, 'bad', `${name} ไม่ถูกต้อง`);
  return v;
}
function bahtToSatang(v, name) {
  if (typeof v !== 'number' || !isFinite(v)) throw new HttpError(400, 'bad', `${name} ไม่ถูกต้อง`);
  const s = Math.round(v * 100);
  if (Math.abs(s - v * 100) > 0.001) throw new HttpError(400, 'bad', `${name} ทศนิยมได้ไม่เกิน 2 ตำแหน่ง`);
  return s;
}
function ipOf(req) { return req.headers.get('CF-Connecting-IP') || 'local'; }

// ---------------------------------------------------------------- rate limit (fixed window in D1)
async function hit(env, key, [limit, win]) {
  const t = now();
  const row = await env.DB.prepare(
    `INSERT INTO rl (k, n, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN rl.reset_at <= ?3 THEN 1 ELSE rl.n + 1 END,
       reset_at = CASE WHEN rl.reset_at <= ?3 THEN ?2 ELSE rl.reset_at END
     RETURNING n, reset_at`
  ).bind(key, t + win, t).first();
  return { over: row.n > limit, n: row.n, wait: Math.max(1, row.reset_at - t) };
}
async function peek(env, keys) {
  const t = now();
  const ph = keys.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await env.DB.prepare(`SELECT k, n, reset_at FROM rl WHERE k IN (${ph})`).bind(...keys).all();
  const m = {};
  for (const r of results) if (r.reset_at > t) m[r.k] = { n: r.n, wait: r.reset_at - t };
  return m;
}
function tooMany(wait, msg) {
  return new HttpError(429, 'rate', msg || `ลองบ่อยเกินไป กรุณารอ ${Math.ceil(wait / 60)} นาที`, { retryAfter: wait });
}

// ---------------------------------------------------------------- schema / settings
let _schemaOk = false;
async function ensureSchema(env) {
  if (_schemaOk) return;
  if (!env.DB) throw new HttpError(500, 'config', 'ยังไม่ได้ผูกฐานข้อมูล D1 ชื่อ DB กับ Worker');
  let ok = false;
  try { const r = await env.DB.prepare(`SELECT v FROM meta WHERE k='schema'`).first(); ok = r && r.v === SCHEMA_VERSION; } catch (_) { ok = false; }
  if (!ok) await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  _schemaOk = true;
}
async function getSettings(env) {
  const { results } = await env.DB.prepare(`SELECT k, v FROM settings WHERE k IN ('promo','limits')`).all();
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const r of results) { try { s[r.k] = JSON.parse(r.v); } catch (_) {} }
  return s;
}
function bonusFor(settings, amount, date) {
  const p = settings.promo;
  if (!p || !p.start || !p.end || date < p.start || date > p.end) return 0;
  let bp = 0;
  for (const t of p.tiers || []) if (amount >= t.min && t.bp > bp) bp = t.bp;
  return bp;
}

// ---------------------------------------------------------------- sessions
async function newSession(env, kind, memberId, mustChange, ip) {
  const token = randToken(32);
  const t = now();
  const ttl = kind === 'm' ? MEMBER_TTL : ADMIN_TTL;
  await env.DB.prepare(`INSERT INTO sessions (h, kind, member_id, must_change, created_at, expires_at, ip) VALUES (?,?,?,?,?,?,?)`)
    .bind(await sha256(token), kind, memberId || null, mustChange ? 1 : 0, t, t + ttl, ip).run();
  return { token, expiresIn: ttl };
}
async function auth(env, req, kinds) {
  const h = req.headers.get('Authorization') || '';
  const m = /^Bearer ([A-Za-z0-9_-]{40,60})$/.exec(h);
  if (!m) throw new HttpError(401, 'auth', 'กรุณาเข้าสู่ระบบใหม่');
  const s = await env.DB.prepare(`SELECT h, kind, member_id, must_change, expires_at FROM sessions WHERE h=? AND expires_at>?`)
    .bind(await sha256(m[1]), now()).first();
  if (!s || !kinds.includes(s.kind)) throw new HttpError(401, 'auth', 'กรุณาเข้าสู่ระบบใหม่');
  return s;
}
function audit(env, actor, action, memberId, detail, ip) {
  return env.DB.prepare(`INSERT INTO audit (at, actor, action, member_id, detail, ip) VALUES (?,?,?,?,?,?)`)
    .bind(now(), actor, action, memberId || null, detail ? JSON.stringify(detail).slice(0, 2000) : null, ip);
}

// ---------------------------------------------------------------- member endpoints
async function memberLogin(env, body, ip) {
  const r = await hit(env, `lip:${ip}`, LOGIN_IP_LIMIT);
  if (r.over) throw tooMany(r.wait);
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
  if (!reId.test(id) || !rePin.test(pin)) throw new HttpError(400, 'bad', 'กรอกเบอร์ 7 หลัก และ PIN 6 หลัก');

  // count the attempt first (atomic upsert), so parallel guesses cannot slip past the limit
  const a = await hit(env, `fail:${id}`, LOGIN_ID_FAIL);
  const d = await hit(env, `faild:${id}`, LOGIN_ID_FAIL_DAY);
  if (a.over || d.over) {
    const wait = d.over ? d.wait : a.wait;
    throw new HttpError(423, 'locked', `กรอก PIN ผิดหลายครั้ง ระบบล็อกไว้ชั่วคราว ลองใหม่ใน ${Math.ceil(wait / 60)} นาที หรือติดต่อร้าน`, { retryAfter: wait });
  }

  const m = await env.DB.prepare(`SELECT id, pin_salt, pin_hash, must_change, status FROM members WHERE id=?`).bind(id).first();
  // always compute a hash so response time does not reveal whether the number exists
  const calc = await pinHash(env, m ? m.pin_salt : 'x', id, pin);
  const good = !!m && m.status === 'active' && safeEq(calc, m.pin_hash);
  if (!good) {
    const left = Math.max(0, LOGIN_ID_FAIL[0] - a.n);
    throw new HttpError(401, 'badlogin', left > 0
      ? `เบอร์หรือ PIN ไม่ถูกต้อง (เหลือ ${left} ครั้งก่อนล็อก)`
      : `เบอร์หรือ PIN ไม่ถูกต้อง ระบบล็อกไว้ 15 นาที`);
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM rl WHERE k IN (?, ?)`).bind(`fail:${id}`, `faild:${id}`),
    env.DB.prepare(`UPDATE members SET last_login=? WHERE id=?`).bind(now(), id),
  ]);
  const s = await newSession(env, 'm', id, m.must_change, ip);
  return { ...s, mustChangePin: !!m.must_change };
}

async function memberMe(env, req) {
  const s = await auth(env, req, ['m']);
  if (s.must_change) throw new HttpError(403, 'mustchange', 'กรุณาตั้ง PIN ใหม่ก่อน');
  const m = await env.DB.prepare(`SELECT id, nickname, status FROM members WHERE id=?`).bind(s.member_id).first();
  if (!m || m.status !== 'active') throw new HttpError(401, 'auth', 'กรุณาเข้าสู่ระบบใหม่');
  const { results } = await env.DB.prepare(
    `SELECT id, type, amount, bonus_bp, delta, branch, occurred_at,
            SUM(delta) OVER (ORDER BY occurred_at, id ROWS UNBOUNDED PRECEDING) AS bal
       FROM txns WHERE member_id=? AND voided_at IS NULL ORDER BY occurred_at DESC, id DESC LIMIT 100`
  ).bind(m.id).all();
  const bal = await env.DB.prepare(`SELECT COALESCE(SUM(delta),0) AS b, COALESCE(-SUM(CASE WHEN type='use' THEN delta END),0) AS used
      FROM txns WHERE member_id=? AND voided_at IS NULL`).bind(m.id).first();
  return {
    member: { id: m.id, nickname: m.nickname },
    balance: bal.b,
    used: bal.used,
    txns: results.map((t) => ({ type: t.type, amount: t.amount, bonusBp: t.bonus_bp, delta: t.delta, branch: t.branch, at: t.occurred_at, bal: t.bal })),
  };
}

async function memberChangePin(env, req, body, ip) {
  const s = await auth(env, req, ['m']);
  const oldPin = typeof body.oldPin === 'string' ? body.oldPin : '';
  const newPin = typeof body.newPin === 'string' ? body.newPin : '';
  const r = await hit(env, `cpin:${s.member_id}`, [10, 15 * 60]);
  if (r.over) throw tooMany(r.wait);
  const m = await env.DB.prepare(`SELECT id, pin_salt, pin_hash FROM members WHERE id=?`).bind(s.member_id).first();
  if (!m || !safeEq(await pinHash(env, m.pin_salt, m.id, oldPin), m.pin_hash)) throw new HttpError(401, 'badpin', 'PIN เดิมไม่ถูกต้อง');
  if (!rePin.test(newPin)) throw new HttpError(400, 'bad', 'PIN ใหม่ต้องเป็นตัวเลข 6 หลัก');
  if (newPin === oldPin) throw new HttpError(400, 'weak', 'PIN ใหม่ต้องไม่ซ้ำกับ PIN เดิม');
  if (weakPin(newPin, m.id)) throw new HttpError(400, 'weak', 'PIN นี้เดาง่ายเกินไป (เช่น 123456, 111111, เลขเรียง หรือเลขเบอร์ตัวเอง) กรุณาตั้งใหม่');
  const salt = randToken(16);
  await env.DB.batch([
    env.DB.prepare(`UPDATE members SET pin_salt=?, pin_hash=?, must_change=0, updated_at=? WHERE id=?`)
      .bind(salt, await pinHash(env, salt, m.id, newPin), now(), m.id),
    env.DB.prepare(`DELETE FROM sessions WHERE kind='m' AND member_id=?`).bind(m.id), // log out every device
  ]);
  const ns = await newSession(env, 'm', m.id, 0, ip);
  return { ok: true, ...ns };
}

async function logout(env, req) {
  const h = req.headers.get('Authorization') || '';
  const m = /^Bearer ([A-Za-z0-9_-]{40,60})$/.exec(h);
  if (m) await env.DB.prepare(`DELETE FROM sessions WHERE h=?`).bind(await sha256(m[1])).run();
  return { ok: true };
}

// ---------------------------------------------------------------- admin endpoints
async function adminLogin(env, body, ip) {
  const r = await hit(env, `aip:${ip}`, ADMIN_IP_LIMIT);
  if (r.over) throw tooMany(r.wait);
  const g = await peek(env, ['afail']);
  if (g.afail && g.afail.n >= ADMIN_FAIL_ALL[0]) throw tooMany(g.afail.wait, `มีการเดารหัสแอดมินผิดหลายครั้ง ระบบปิดการเข้าแอดมินชั่วคราว ${Math.ceil(g.afail.wait / 60)} นาที`);
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 10) throw new HttpError(500, 'config', 'ยังไม่ได้ตั้ง ADMIN_PASSWORD (อย่างน้อย 10 ตัว)');
  const pw = typeof body.password === 'string' ? body.password : '';
  const given = await hmac(env, `admin:${pw}`);
  let role = null;
  if (safeEq(given, await hmac(env, `admin:${env.ADMIN_PASSWORD}`))) role = 'owner';
  else if (env.STAFF_PASSWORD && env.STAFF_PASSWORD.length >= 8 && safeEq(given, await hmac(env, `admin:${env.STAFF_PASSWORD}`))) role = 'staff';
  if (!role) {
    await hit(env, 'afail', ADMIN_FAIL_ALL);
    await audit(env, 'unknown', 'admin_login_fail', null, null, ip).run();
    throw new HttpError(401, 'badlogin', 'รหัสผ่านไม่ถูกต้อง');
  }
  await audit(env, role, 'admin_login', null, null, ip).run();
  const s = await newSession(env, role, null, 0, ip);
  return { ...s, role };
}

function needOwner(s) { if (s.kind !== 'owner') throw new HttpError(403, 'forbidden', 'เฉพาะเจ้าของร้าน'); }

async function memberDetail(env, id, full) {
  const m = await env.DB.prepare(`SELECT id, nickname, gender, must_change, status, last_login, created_at FROM members WHERE id=?`).bind(id).first();
  if (!m) throw new HttpError(404, 'notfound', 'ไม่พบสมาชิก');
  const { results } = await env.DB.prepare(
    `SELECT id, type, amount, bonus_bp, delta, branch, method, bank, note, occurred_at, created_by, voided_at, voided_by, void_reason
       FROM txns WHERE member_id=? ORDER BY occurred_at DESC, id DESC LIMIT ${full ? 500 : 50}`
  ).bind(id).all();
  const bal = await env.DB.prepare(`SELECT COALESCE(SUM(delta),0) AS b, COALESCE(SUM(CASE WHEN type='topup' THEN delta END),0) AS credit,
      COALESCE(-SUM(CASE WHEN type='use' THEN delta END),0) AS used FROM txns WHERE member_id=? AND voided_at IS NULL`).bind(id).first();
  const f = await peek(env, [`fail:${id}`, `faild:${id}`]);
  const locked = (f[`faild:${id}`] && f[`faild:${id}`].n >= LOGIN_ID_FAIL_DAY[0]) || (f[`fail:${id}`] && f[`fail:${id}`].n >= LOGIN_ID_FAIL[0]);
  const fails = f[`fail:${id}`] ? f[`fail:${id}`].n : 0;
  return { member: { ...m, locked: !!locked, recentFails: fails }, balance: bal.b, credit: bal.credit, used: bal.used, txns: results };
}

async function adminRoute(env, req, path, body, ip) {
  if (path === '/api/admin/login') return adminLogin(env, body, ip);
  const s = await auth(env, req, ['owner', 'staff']);
  const actor = s.kind;

  switch (path) {
    case '/api/admin/me':
      return { role: s.kind };

    case '/api/admin/summary': {
      const a = await env.DB.prepare(`SELECT COUNT(*) AS members, SUM(CASE WHEN last_login IS NOT NULL THEN 1 ELSE 0 END) AS loggedIn,
                                       SUM(CASE WHEN must_change=0 THEN 1 ELSE 0 END) AS pinSet FROM members`).first();
      const b = await env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN type='topup' THEN amount END),0) AS paid,
          COALESCE(SUM(CASE WHEN type='topup' THEN delta END),0) AS credit,
          COALESCE(-SUM(CASE WHEN type='use' THEN delta END),0) AS used,
          COUNT(CASE WHEN type='topup' THEN 1 END) AS nTop, COUNT(CASE WHEN type='use' THEN 1 END) AS nUse
          FROM txns WHERE voided_at IS NULL`).first();
      const settings = await getSettings(env);
      return { ...a, ...b, balance: b.credit - b.used, settings, today: bkkDate() };
    }

    case '/api/admin/search': {
      const q = str(body.q, 30, 'คำค้น');
      let rows;
      if (/^\d{3,7}$/.test(q)) {
        rows = await env.DB.prepare(`SELECT id, nickname, gender FROM members WHERE id LIKE ? ORDER BY id LIMIT 50`).bind(`%${q}%`).all();
      } else if (q.length >= 1) {
        const n = q.replace(/[%_\\]/g, '').slice(0, 15); // D1 LIKE pattern max 50 bytes
        rows = await env.DB.prepare(`SELECT id, nickname, gender FROM members WHERE nickname LIKE ? ORDER BY nickname, id LIMIT 50`).bind(`%${n}%`).all();
      } else {
        rows = await env.DB.prepare(`SELECT id, nickname, gender FROM members ORDER BY created_at DESC, id LIMIT 30`).all();
      }
      return { results: rows.results };
    }

    case '/api/admin/member': {
      const id = str(body.id, 7, 'เบอร์');
      if (!reId.test(id)) throw new HttpError(400, 'bad', 'เบอร์ต้องเป็นตัวเลข 7 หลัก');
      return memberDetail(env, id, s.kind === 'owner');
    }

    case '/api/admin/member/create': {
      const id = str(body.id, 7, 'เบอร์');
      if (!reId.test(id)) throw new HttpError(400, 'bad', 'เบอร์ต้องเป็นตัวเลข 7 หลัก');
      const nickname = str(body.nickname, 40, 'ชื่อเล่น');
      if (!nickname) throw new HttpError(400, 'bad', 'กรอกชื่อเล่น');
      const gender = str(body.gender, 10, 'เพศ');
      const pin = randPin(); const salt = randToken(16);
      const res = await env.DB.prepare(`INSERT OR IGNORE INTO members (id, nickname, gender, pin_salt, pin_hash, must_change, created_at) VALUES (?,?,?,?,?,1,?)`)
        .bind(id, nickname, gender, salt, await pinHash(env, salt, id, pin), now()).run();
      if (!res.meta.changes) throw new HttpError(409, 'exists', 'เบอร์นี้เป็นสมาชิกอยู่แล้ว');
      await audit(env, actor, 'member_create', id, { nickname }, ip).run();
      return { ok: true, id, pin };
    }

    case '/api/admin/topup': {
      const id = str(body.id, 7, 'เบอร์');
      if (!reId.test(id)) throw new HttpError(400, 'bad', 'เบอร์ต้องเป็นตัวเลข 7 หลัก');
      const settings = await getSettings(env);
      const amount = bahtToSatang(body.amount, 'ยอดเติม');
      if (amount < settings.limits.minTopup || amount > settings.limits.maxTopup)
        throw new HttpError(400, 'bad', `ยอดเติมต้องอยู่ระหว่าง ${settings.limits.minTopup / 100}–${settings.limits.maxTopup / 100} บาท`);
      const branch = str(body.branch, 10, 'สาขา'); if (!BRANCHES.includes(branch)) throw new HttpError(400, 'bad', 'เลือกสาขา');
      const method = str(body.method, 10, 'ช่องทาง'); if (!METHODS.includes(method)) throw new HttpError(400, 'bad', 'เลือกช่องทางจ่าย');
      const bank = str(body.bank, 30, 'ธนาคาร');
      const note = str(body.note, 120, 'หมายเหตุ');
      const clientId = str(body.clientId, 64, 'clientId'); if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw new HttpError(400, 'bad', 'clientId');
      const today = bkkDate();
      let at = bkkStamp();
      if (body.date && s.kind === 'owner') { const d = str(body.date, 16, 'วันที่'); if (!reDate.test(d) || d.slice(0, 10) > today) throw new HttpError(400, 'bad', 'วันที่ไม่ถูกต้อง'); at = d; }
      const bp = bonusFor(settings, amount, at.slice(0, 10));
      const credit = amount + Math.round(amount * bp / 10000);
      const m = await env.DB.prepare(`SELECT id FROM members WHERE id=? AND status='active'`).bind(id).first();
      if (!m) throw new HttpError(404, 'notfound', 'ไม่พบสมาชิก');
      const res = await env.DB.prepare(`INSERT OR IGNORE INTO txns (member_id, type, amount, bonus_bp, delta, branch, method, bank, note, occurred_at, created_at, created_by, client_id)
          VALUES (?, 'topup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, amount, bp, credit, branch, method, bank, note, at, now(), actor, clientId).run();
      if (res.meta.changes) await audit(env, actor, 'topup', id, { amount, bp, credit, branch, method }, ip).run();
      const bal = await env.DB.prepare(`SELECT COALESCE(SUM(delta),0) AS b FROM txns WHERE member_id=? AND voided_at IS NULL`).bind(id).first();
      return { ok: true, duplicate: !res.meta.changes, amount, bonusBp: bp, credit, balance: bal.b };
    }

    case '/api/admin/use': {
      const id = str(body.id, 7, 'เบอร์');
      if (!reId.test(id)) throw new HttpError(400, 'bad', 'เบอร์ต้องเป็นตัวเลข 7 หลัก');
      const settings = await getSettings(env);
      const amount = bahtToSatang(body.amount, 'ยอดใช้');
      if (amount <= 0 || amount > settings.limits.maxUse) throw new HttpError(400, 'bad', `ยอดใช้ต้องอยู่ระหว่าง 0.01–${settings.limits.maxUse / 100} บาท`);
      const branch = str(body.branch, 10, 'สาขา'); if (!BRANCHES.includes(branch)) throw new HttpError(400, 'bad', 'เลือกสาขา');
      const note = str(body.note, 120, 'หมายเหตุ');
      const clientId = str(body.clientId, 64, 'clientId'); if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw new HttpError(400, 'bad', 'clientId');
      let at = bkkStamp();
      if (body.date && s.kind === 'owner') { const d = str(body.date, 16, 'วันที่'); if (!reDate.test(d) || d.slice(0, 10) > bkkDate()) throw new HttpError(400, 'bad', 'วันที่ไม่ถูกต้อง'); at = d; }
      let dup = false;
      {
        // single atomic statement: only inserts when the balance covers the amount
        const res = await env.DB.prepare(`INSERT OR IGNORE INTO txns (member_id, type, amount, bonus_bp, delta, branch, method, bank, note, occurred_at, created_at, created_by, client_id)
            SELECT ?1, 'use', ?2, 0, -?2, ?3, 'credit', '', ?4, ?5, ?6, ?7, ?8
             WHERE EXISTS (SELECT 1 FROM members WHERE id=?1 AND status='active')
               AND (SELECT COALESCE(SUM(delta),0) FROM txns WHERE member_id=?1 AND voided_at IS NULL) >= ?2`)
          .bind(id, amount, branch, note, at, now(), actor, clientId).run();
        if (!res.meta.changes) {
          dup = !!(await env.DB.prepare(`SELECT id FROM txns WHERE client_id=?`).bind(clientId).first());
          if (!dup) {
            const bal = await env.DB.prepare(`SELECT COALESCE(SUM(delta),0) AS b FROM txns WHERE member_id=? AND voided_at IS NULL`).bind(id).first();
            throw new HttpError(409, 'insufficient', `เครดิตไม่พอ (คงเหลือ ${(bal.b / 100).toFixed(2)} บาท)`);
          }
        } else {
          await audit(env, actor, 'use', id, { amount, branch }, ip).run();
        }
      }
      const bal = await env.DB.prepare(`SELECT COALESCE(SUM(delta),0) AS b FROM txns WHERE member_id=? AND voided_at IS NULL`).bind(id).first();
      return { ok: true, duplicate: dup, amount, balance: bal.b };
    }

    case '/api/admin/void': {
      needOwner(s);
      const txnId = intIn(body.txnId, 1, 1e12, 'รายการ');
      const reason = str(body.reason, 120, 'เหตุผล');
      if (reason.length < 3) throw new HttpError(400, 'bad', 'กรุณาใส่เหตุผลที่ยกเลิก');
      const t = await env.DB.prepare(`SELECT id, member_id, type, delta, voided_at FROM txns WHERE id=?`).bind(txnId).first();
      if (!t) throw new HttpError(404, 'notfound', 'ไม่พบรายการ');
      if (t.voided_at) throw new HttpError(409, 'voided', 'รายการนี้ถูกยกเลิกไปแล้ว');
      const res = await env.DB.prepare(`UPDATE txns SET voided_at=?1, voided_by=?2, void_reason=?3
          WHERE id=?4 AND voided_at IS NULL
            AND (type='use' OR (SELECT COALESCE(SUM(delta),0) FROM txns WHERE member_id=?5 AND voided_at IS NULL) - delta >= 0)`)
        .bind(now(), actor, reason, txnId, t.member_id).run();
      if (!res.meta.changes) throw new HttpError(409, 'insufficient', 'ยกเลิกไม่ได้ เพราะลูกค้าใช้เครดิตจากยอดนี้ไปแล้ว (ยอดจะติดลบ)');
      await audit(env, actor, 'void', t.member_id, { txnId, type: t.type, delta: t.delta, reason }, ip).run();
      return { ok: true };
    }

    case '/api/admin/reset-pin': {
      needOwner(s);
      const id = str(body.id, 7, 'เบอร์'); if (!reId.test(id)) throw new HttpError(400, 'bad', 'เบอร์ต้องเป็นตัวเลข 7 หลัก');
      const pin = randPin(); const salt = randToken(16);
      const res = await env.DB.prepare(`UPDATE members SET pin_salt=?, pin_hash=?, must_change=1, updated_at=? WHERE id=?`)
        .bind(salt, await pinHash(env, salt, id, pin), now(), id).run();
      if (!res.meta.changes) throw new HttpError(404, 'notfound', 'ไม่พบสมาชิก');
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM sessions WHERE kind='m' AND member_id=?`).bind(id),
        env.DB.prepare(`DELETE FROM rl WHERE k IN (?, ?)`).bind(`fail:${id}`, `faild:${id}`),
        await audit(env, actor, 'reset_pin', id, null, ip),
      ]);
      return { ok: true, id, pin };
    }

    case '/api/admin/unlock': {
      needOwner(s);
      const id = str(body.id, 7, 'เบอร์'); if (!reId.test(id)) throw new HttpError(400, 'bad', 'เบอร์ต้องเป็นตัวเลข 7 หลัก');
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM rl WHERE k IN (?, ?)`).bind(`fail:${id}`, `faild:${id}`),
        await audit(env, actor, 'unlock', id, null, ip),
      ]);
      return { ok: true };
    }

    case '/api/admin/status': {
      needOwner(s);
      const id = str(body.id, 7, 'เบอร์'); if (!reId.test(id)) throw new HttpError(400, 'bad', 'เบอร์ต้องเป็นตัวเลข 7 หลัก');
      const st = body.status === 'disabled' ? 'disabled' : 'active';
      await env.DB.batch([
        env.DB.prepare(`UPDATE members SET status=?, updated_at=? WHERE id=?`).bind(st, now(), id),
        env.DB.prepare(`DELETE FROM sessions WHERE kind='m' AND member_id=?`).bind(id),
        await audit(env, actor, 'status', id, { status: st }, ip),
      ]);
      return { ok: true, status: st };
    }

    case '/api/admin/settings': {
      needOwner(s);
      const cur = await getSettings(env);
      if (!body.set) return cur;
      const p = body.set.promo || {};
      const name = str(p.name, 60, 'ชื่อโปร');
      const start = str(p.start, 10, 'วันเริ่ม'), end = str(p.end, 10, 'วันสิ้นสุด');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) throw new HttpError(400, 'bad', 'ช่วงวันที่โปรไม่ถูกต้อง');
      if (!Array.isArray(p.tiers) || p.tiers.length > 6) throw new HttpError(400, 'bad', 'ขั้นโปรไม่ถูกต้อง');
      const tiers = p.tiers.map((t) => ({ min: bahtToSatang(t.min, 'ยอดขั้นต่ำ'), bp: intIn(Math.round(t.bp), 0, 10000, 'โบนัส') }))
        .filter((t) => t.min > 0).sort((a, b) => a.min - b.min);
      const promo = { name, start, end, tiers };
      await env.DB.batch([
        env.DB.prepare(`INSERT OR REPLACE INTO settings (k, v) VALUES ('promo', ?)`).bind(JSON.stringify(promo)),
        await audit(env, actor, 'settings', null, promo, ip),
      ]);
      return { ...cur, promo };
    }

    case '/api/admin/import': {
      needOwner(s);
      return adminImport(env, body, actor, ip);
    }

    case '/api/admin/audit': {
      needOwner(s);
      const { results } = await env.DB.prepare(`SELECT at, actor, action, member_id, detail, ip FROM audit ORDER BY id DESC LIMIT 200`).all();
      return { results };
    }

    case '/api/admin/logout':
      return logout(env, req);
  }
  throw new HttpError(404, 'notfound', 'ไม่พบคำสั่งนี้');
}

// Bulk import (owner only). Statements per call stay well under the 50-query limit of the free plan.
async function adminImport(env, body, actor, ip) {
  const members = Array.isArray(body.members) ? body.members : [];
  const txns = Array.isArray(body.txns) ? body.txns : [];
  if (members.length > 100 || txns.length > 250) throw new HttpError(400, 'bad', 'ส่งทีละไม่เกิน 100 สมาชิก / 250 รายการ');
  const t0 = now();
  const stmts = [];
  const pins = [];

  if (members.length) {
    const clean = members.map((m) => {
      const id = str(m.id, 7, 'เบอร์'); if (!reId.test(id)) throw new HttpError(400, 'bad', `เบอร์ไม่ถูกต้อง: ${id}`);
      return { id, nickname: str(m.nickname, 40, 'ชื่อเล่น'), gender: str(m.gender, 10, 'เพศ') };
    });
    const ids = clean.map((m) => m.id);
    const { results } = await env.DB.prepare(`SELECT id FROM members WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    const have = new Set(results.map((r) => r.id));
    const fresh = clean.filter((m, i) => !have.has(m.id) && ids.indexOf(m.id) === i);
    for (let i = 0; i < fresh.length; i += 20) {
      const part = fresh.slice(i, i + 20);
      const vals = []; const params = [];
      for (const m of part) {
        const pin = randPin(); const salt = randToken(16);
        vals.push(`(?,?,?,?,?,1,${t0})`);
        params.push(m.id, m.nickname, m.gender, salt, await pinHash(env, salt, m.id, pin));
        pins.push({ id: m.id, nickname: m.nickname, pin });
      }
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO members (id, nickname, gender, pin_salt, pin_hash, must_change, created_at) VALUES ${vals.join(',')}`).bind(...params));
    }
  }

  if (txns.length) {
    const rows = txns.map((t) => {
      const id = str(t.id, 7, 'เบอร์'); if (!reId.test(id)) throw new HttpError(400, 'bad', `เบอร์ไม่ถูกต้อง: ${id}`);
      const type = t.type === 'topup' ? 'topup' : t.type === 'use' ? 'use' : null; if (!type) throw new HttpError(400, 'bad', 'ชนิดรายการ');
      const amount = intIn(t.amount, 1, 100000000, 'ยอด');
      const bp = intIn(t.bonusBp || 0, 0, 10000, 'โบนัส');
      const delta = type === 'topup' ? amount + Math.round(amount * bp / 10000) : -amount;
      const date = str(t.date, 16, 'วันที่'); if (!reDate.test(date)) throw new HttpError(400, 'bad', `วันที่ไม่ถูกต้อง: ${date}`);
      const cid = str(t.cid, 64, 'cid'); if (!/^[A-Za-z0-9_-]{4,64}$/.test(cid)) throw new HttpError(400, 'bad', 'cid');
      const branch = BRANCHES.includes(t.branch) ? t.branch : '';
      return [id, type, amount, bp, delta, branch, type === 'topup' ? 'transfer' : 'credit', str(t.bank, 30, 'ธนาคาร'), str(t.note, 120, 'หมายเหตุ'), date, cid];
    });
    for (let i = 0; i < rows.length; i += 9) {
      const part = rows.slice(i, i + 9);
      const vals = part.map(() => `(?,?,?,?,?,?,?,?,?,?,${t0},'import',?)`);
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO txns (member_id, type, amount, bonus_bp, delta, branch, method, bank, note, occurred_at, created_at, created_by, client_id) VALUES ${vals.join(',')}`).bind(...part.flat()));
    }
  }
  if (stmts.length > 40) throw new HttpError(400, 'bad', 'ชุดข้อมูลใหญ่เกินไป');
  let changed = 0;
  if (stmts.length) {
    stmts.push(await audit(env, actor, 'import', null, { members: members.length, txns: txns.length }, ip));
    const out = await env.DB.batch(stmts);
    for (let i = 0; i < out.length - 1; i++) changed += out[i].meta.changes || 0;
  }
  return { ok: true, newMembers: pins.length, rowsWritten: changed, pins };
}

// ---------------------------------------------------------------- HTTP plumbing
function origins(env) { return (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean); }
function baseHeaders(origin) {
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Strict-Transport-Security': 'max-age=31536000',
  };
  if (origin) { h['Access-Control-Allow-Origin'] = origin; h['Vary'] = 'Origin'; }
  return h;
}
function json(data, status, origin, extra) { return new Response(JSON.stringify(data), { status, headers: { ...baseHeaders(origin), ...(extra || {}) } }); }

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = req.headers.get('Origin');
    const allowed = origins(env);
    const okOrigin = origin && allowed.includes(origin) ? origin : null;

    if (req.method === 'OPTIONS') {
      if (!okOrigin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': okOrigin, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600', 'Vary': 'Origin' } });
    }
    if (path === '/' || path === '/health') {
      return json({ ok: true, service: 'teddy-member', v: VERSION, origins: allowed.length, db: !!env.DB, pepper: !!(env.PEPPER && env.PEPPER.length >= 32), admin: !!(env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= 10), staff: !!env.STAFF_PASSWORD }, 200, okOrigin);
    }
    if (!path.startsWith('/api/')) return json({ error: 'notfound' }, 404, okOrigin);
    // browser requests must come from our own pages
    if (!okOrigin) return json({ error: 'origin', message: 'ไม่อนุญาตให้เรียกจากเว็บนี้' }, 403, null);
    if (req.method !== 'POST') return json({ error: 'method' }, 405, okOrigin);
    if (!(req.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return json({ error: 'type' }, 415, okOrigin);

    const ip = ipOf(req);
    try {
      const len = Number(req.headers.get('Content-Length') || 0);
      if (len > MAX_BODY) throw new HttpError(413, 'big', 'ข้อมูลใหญ่เกินไป');
      const text = await req.text();
      if (text.length > MAX_BODY) throw new HttpError(413, 'big', 'ข้อมูลใหญ่เกินไป');
      let body = {};
      if (text) { try { body = JSON.parse(text); } catch (_) { throw new HttpError(400, 'bad', 'JSON ไม่ถูกต้อง'); } }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad', 'ข้อมูลไม่ถูกต้อง');

      await ensureSchema(env);
      const g = await hit(env, `api:${ip}`, API_IP_LIMIT);
      if (g.over) throw tooMany(g.wait);

      let data;
      if (path === '/api/login') data = await memberLogin(env, body, ip);
      else if (path === '/api/me') data = await memberMe(env, req);
      else if (path === '/api/change-pin') data = await memberChangePin(env, req, body, ip);
      else if (path === '/api/logout') data = await logout(env, req);
      else if (path.startsWith('/api/admin/')) data = await adminRoute(env, req, path, body, ip);
      else throw new HttpError(404, 'notfound', 'ไม่พบคำสั่งนี้');

      if (Math.random() < 0.02) {
        ctx.waitUntil(env.DB.batch([
          env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now()),
          env.DB.prepare(`DELETE FROM rl WHERE reset_at < ?`).bind(now() - 3600),
        ]).catch(() => {}));
      }
      return json(data, 200, okOrigin);
    } catch (e) {
      if (e instanceof HttpError) {
        const extra = e.extra && e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : undefined;
        return json({ error: e.code, message: e.message }, e.status, okOrigin, extra);
      }
      console.error('unhandled', e && e.stack || e);
      return json({ error: 'server', message: 'ระบบขัดข้อง ลองใหม่อีกครั้ง' }, 500, okOrigin);
    }
  },
};
