// 動画評価実験 — Cloudflare Worker + D1
//
// AGEWEC 本体（agewec-site / agewec_2026）とは別の Worker・別の D1。互いに干渉しない。
// Cloudflare Access は使わず、メールアドレス + パスワードでログインする。
//
//   /          ログイン
//   /setup/    初期化（スキーマ作成 + 初期データ投入。1回だけ）
//   /admin/    管理画面
//   /evaluate/ 評価画面
//   /api/...   API
//
// ダッシュボードで設定するもの:
//   D1 バインディング  DB          （データベースは自分で作る。名前は videoeval など）
//   シークレット       SESSION_SECRET   Cookie の署名鍵。長いランダム文字列
//   シークレット       BOOTSTRAP_TOKEN  /setup/ で使う合言葉。初期化が済めば不要

import { SEED_RATERS, SEED_VIDEOS } from "./seed.js";

// ---------- 評価項目（唯一の出典） ----------
const ITEMS_VERSION = "0.1.0";
const ITEMS = [
  { id: "q1", layer: 1, name: "技術的破綻", type: "ordinal", options: [
    "見続けるのが難しいほど崩れている", "崩れが気になって内容が入ってこない",
    "気になる箇所はあるが内容は伝わる", "特に気にならない"] },
  { id: "q2", layer: 1, name: "北九州市の識別", type: "binary", options: [
    "北九州市の紹介だとは分からない", "北九州市の紹介だと分かる"] },
  { id: "q3", layer: 1, name: "メッセージ明瞭性", type: "ordinal", options: [
    "何を伝えたいのか分からない", "漠然と「良い場所」と言っているだけ",
    "伝えたいものがいくつか示されている", "何を伝えたいかが明確に絞られている"] },
  { id: "q4", layer: 2, name: "都市名の置換可能性", type: "ordinal", options: [
    "他の都市名に変えてもそのまま成立する", "少し手を入れれば他の都市でも成立する",
    "一部は北九州でないと成立しない", "北九州でなければ成立しない"] },
  { id: "q5", layer: 2, name: "観光情報の具体性", type: "ordinal", options: [
    "北九州で何ができるか分からない", "雰囲気だけ伝わる",
    "行き先や体験が1つ2つ示されている", "行き先や体験が具体的に示されている"] },
  { id: "q6", layer: 2, name: "知覚された独自性", type: "ordinal", options: [
    "同じような動画を何度も見たことがある", "よくある表現だと感じる",
    "あまり見ない表現だと感じる", "これまで見たことのない表現だと感じる"] },
  { id: "q7", layer: 3, name: "訪問意欲", type: "ordinal", options: [
    "行ってみたいとは思わない", "少し興味を持った",
    "詳しく調べてみたいと思った", "旅行先の候補として考えたいと思った"] },
  { id: "q8", layer: 3, name: "共有意向", type: "ordinal", options: [
    "共有しようと思わない", "話題として口頭で伝える程度",
    "知人に個別に送りたい", "SNSなどで公開して薦めたい"] },
];
const LAYER_LABEL = { 1: "適格性", 2: "地域固有性", 3: "訴求力" };
const PRE_QUESTIONS = [
  { id: "p1", name: "北九州市への訪問経験", options: ["行ったことがない", "通過したことがある", "1回行ったことがある", "2回以上行ったことがある"] },
  { id: "p2", name: "現時点での北九州市への訪問意欲", options: ["行ってみたいとは思わない", "少し興味がある", "詳しく調べてみたい", "旅行先の候補として考えたい"] },
  { id: "p3", name: "出身地（都道府県）", type: "text" },
  { id: "p4", name: "これまでの居住地（都道府県、複数可）", type: "text" },
];

// ---------- スキーマ（Worker が自分で作る。wrangler の migrations を使わずに済ませる） ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS raters (
     email TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'rater',
     pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, seed INTEGER NOT NULL,
     active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS videos (
     id TEXT PRIMARY KEY, student_id TEXT, student_name TEXT, url TEXT NOT NULL,
     embed_url TEXT, award TEXT DEFAULT '', url_status TEXT DEFAULT '',
     active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS tasks (
     rater_email TEXT NOT NULL, position INTEGER NOT NULL, video_id TEXT NOT NULL,
     is_repeat INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (rater_email, position))`,
  `CREATE TABLE IF NOT EXISTS responses (
     rater_email TEXT NOT NULL, position INTEGER NOT NULL, video_id TEXT NOT NULL,
     q1 INTEGER, q2 INTEGER, q3 INTEGER, q4 INTEGER, q5 INTEGER, q6 INTEGER, q7 INTEGER, q8 INTEGER,
     elapsed_ms INTEGER, items_version TEXT, created_at TEXT, updated_at TEXT,
     PRIMARY KEY (rater_email, position))`,
  `CREATE TABLE IF NOT EXISTS surveys (
     rater_email TEXT NOT NULL, kind TEXT NOT NULL, block INTEGER NOT NULL DEFAULT 0,
     payload TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (rater_email, kind, block))`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_rater ON tasks(rater_email)`,
  `CREATE INDEX IF NOT EXISTS idx_responses_video ON responses(video_id)`,
];
const DEFAULT_SETTINGS = [["block_size", "25"], ["repeat_count", "10"], ["open", "1"]];

// ---------- 小道具 ----------
const json = (d, s = 200, h = {}) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", ...h } });
const text = (b, s = 200, h = {}) => new Response(b, { status: s, headers: h });
const enc = new TextEncoder();
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => new Uint8Array((s.match(/../g) || []).map((x) => parseInt(x, 16)));
const nowIso = () => new Date().toISOString();

async function pwHash(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unhex(saltHex), iterations: 100000, hash: "SHA-256" }, key, 256);
  return hex(bits);
}
async function hmac(env, msg) {
  const secret = env.SESSION_SECRET || "dev-insecure-secret-change-me";
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
const SESSION_DAYS = 30;
async function makeToken(env, email) {
  const body = `${email}.${Date.now() + SESSION_DAYS * 86400000}`;
  return `${body}.${await hmac(env, body)}`;
}
async function readToken(env, token) {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const body = token.slice(0, i);
  if ((await hmac(env, body)) !== token.slice(i + 1)) return null;
  const j = body.lastIndexOf(".");
  if (!(Number(body.slice(j + 1)) > Date.now())) return null;
  return body.slice(0, j);
}
function cookieOf(request, name) {
  for (const p of (request.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = p.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
async function getUser(db, env, request) {
  const email = await readToken(env, cookieOf(request, "ve_session"));
  if (!email) return null;
  const row = await db.prepare("SELECT email,name,role,active,seed FROM raters WHERE email=?1").bind(email).first();
  return row && row.active ? row : null;
}
const cookieHeader = (v, maxAge) => `ve_session=${v}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}; Secure`;

async function setting(db, key, dflt) {
  const r = await db.prepare("SELECT value FROM settings WHERE key=?1").bind(key).first();
  return r ? r.value : dflt;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, seed) {
  const a = arr.slice(), rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function toEmbed(url) {
  const u = String(url || "");
  let m = u.match(/drive\.google\.com\/file\/d\/([^/]+)/); if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  m = u.match(/drive\.google\.com\/open\?id=([^&]+)/); if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/); if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = u.match(/vimeo\.com\/(\d+)/); if (m) return `https://player.vimeo.com/video/${m[1]}`;
  return "";
}

async function buildTasks(db, rater, force = false) {
  if (!force) {
    const n = await db.prepare("SELECT COUNT(*) n FROM tasks WHERE rater_email=?1").bind(rater.email).first();
    if (n && n.n > 0) return n.n;
  }
  const repeatCount = Number(await setting(db, "repeat_count", "10"));
  const vids = ((await db.prepare("SELECT id FROM videos WHERE active=1 ORDER BY id").all()).results || []).map((r) => r.id);
  if (!vids.length) return 0;
  const order = shuffled(vids, rater.seed);
  const rnd = mulberry32(rater.seed ^ 0x9e3779b9);
  const half = Math.max(1, Math.floor(order.length / 2));
  const repeats = shuffled(order.slice(0, half), rater.seed ^ 0x5bf03635).slice(0, Math.min(repeatCount, half));
  const seq = order.map((v) => ({ v, r: 0 }));
  for (const v of repeats) {
    const at = half + Math.floor(rnd() * Math.max(1, seq.length - half));
    seq.splice(at, 0, { v, r: 1 });
  }
  await db.prepare("DELETE FROM tasks WHERE rater_email=?1").bind(rater.email).run();
  const st = db.prepare("INSERT INTO tasks (rater_email,position,video_id,is_repeat) VALUES (?1,?2,?3,?4)");
  const batch = seq.map((s, i) => st.bind(rater.email, i, s.v, s.r));
  for (let i = 0; i < batch.length; i += 40) await db.batch(batch.slice(i, i + 40));
  return seq.length;
}

// ---------- 初期化 ----------
async function tablesExist(db) {
  try { await db.prepare("SELECT 1 FROM raters LIMIT 1").first(); return true; } catch { return false; }
}
async function apiSetupStatus(db, env) {
  if (!(await tablesExist(db))) return json({ initialized: false, ready: !!env.BOOTSTRAP_TOKEN });
  const n = await db.prepare("SELECT COUNT(*) n FROM raters").first();
  return json({ initialized: !!(n && n.n > 0), ready: !!env.BOOTSTRAP_TOKEN });
}
async function apiSetup(db, env, request) {
  if (!env.BOOTSTRAP_TOKEN) return json({ error: "bootstrap_disabled" }, 403);
  let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  if (String(d.token || "") !== env.BOOTSTRAP_TOKEN) return json({ error: "bad_token" }, 401);

  for (const sql of SCHEMA) await db.prepare(sql).run();
  const n = await db.prepare("SELECT COUNT(*) n FROM raters").first();
  if (n && n.n > 0) return json({ error: "already_initialized" }, 409);

  const st = db.prepare("INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO NOTHING");
  await db.batch(DEFAULT_SETTINGS.map(([k, v]) => st.bind(k, v)));

  const rs = db.prepare(`INSERT INTO raters (email,name,role,pw_salt,pw_hash,seed,active,created_at)
                         VALUES (?1,?2,?3,?4,?5,?6,1,?7)`);
  await db.batch(SEED_RATERS.map((r) => rs.bind(r.email, r.name, r.role, r.pw_salt, r.pw_hash, r.seed, nowIso())));

  const vs = db.prepare(`INSERT INTO videos (id,student_id,student_name,url,embed_url,award,url_status,active)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`);
  const vb = SEED_VIDEOS.map((v) => vs.bind(v.id, v.student_id, v.student_name, v.url,
    v.embed_url || toEmbed(v.url), v.award || "", v.url_status || "", v.active ? 1 : 0));
  for (let i = 0; i < vb.length; i += 40) await db.batch(vb.slice(i, i + 40));

  return json({ ok: true, raters: SEED_RATERS.length, videos: SEED_VIDEOS.length });
}

// ---------- モニタリング用の点数化 ----------
// 進行状況を見るための集計であり、研究上の効用値ではない。
const LAYER_ITEMS = { 1: ["q1", "q2", "q3"], 2: ["q4", "q5", "q6"], 3: ["q7", "q8"] };
const LAYER_MAX = { 1: 7, 2: 9, 3: 6 };
const TOTAL_MAX = LAYER_MAX[1] + LAYER_MAX[2] + LAYER_MAX[3];
const sum = (r, ks) => ks.reduce((a, k) => a + (r[k] || 0), 0);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const scoreOf = (r) => {
  const l1 = sum(r, LAYER_ITEMS[1]), l2 = sum(r, LAYER_ITEMS[2]), l3 = sum(r, LAYER_ITEMS[3]);
  return { l1, l2, l3, total: l1 + l2 + l3 };
};

async function apiProgress(db) {
  const rows = (await db.prepare(
    `SELECT r.rater_email,r.position,r.video_id,r.elapsed_ms,
            r.q1,r.q2,r.q3,r.q4,r.q5,r.q6,r.q7,r.q8,t.is_repeat
       FROM responses r JOIN tasks t
         ON t.rater_email=r.rater_email AND t.position=r.position`).all()).results || [];
  const vids = (await db.prepare("SELECT id,student_id,student_name,active,url_status FROM videos ORDER BY id").all()).results || [];
  const first = rows.filter((r) => !r.is_repeat), repeat = rows.filter((r) => r.is_repeat);

  const byVideo = {};
  for (const r of first) (byVideo[r.video_id] = byVideo[r.video_id] || []).push(scoreOf(r));
  const videos = vids.map((v) => {
    const s = byVideo[v.id] || [], tot = s.map((x) => x.total);
    return { id: v.id, student_id: v.student_id, student_name: v.student_name, active: v.active,
      url_status: v.url_status, n: s.length,
      l1: r2(mean(s.map((x) => x.l1))), l2: r2(mean(s.map((x) => x.l2))), l3: r2(mean(s.map((x) => x.l3))),
      total: r2(mean(tot)), total_sd: r2(sd(tot)),
      total_pct: s.length ? Math.round((100 * mean(tot)) / TOTAL_MAX) : null };
  });

  const byRater = {};
  for (const r of first) (byRater[r.rater_email] = byRater[r.rater_email] || []).push({ ...scoreOf(r), ms: r.elapsed_ms });
  const raters = Object.entries(byRater).map(([email, s]) => {
    const tot = s.map((x) => x.total);
    const ms = s.map((x) => x.ms).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return { email, n: s.length,
      l1: r2(mean(s.map((x) => x.l1))), l2: r2(mean(s.map((x) => x.l2))), l3: r2(mean(s.map((x) => x.l3))),
      total: r2(mean(tot)), total_sd: r2(sd(tot)),
      median_ms: ms.length ? ms[Math.floor(ms.length / 2)] : null,
      fast_rate: ms.length ? r2(ms.filter((x) => x < 5000).length / ms.length) : null };
  }).sort((a, b) => (b.total || 0) - (a.total || 0));

  const key = (r) => r.rater_email + "|" + r.video_id;
  const firstMap = {};
  for (const r of first) firstMap[key(r)] = r;
  const ITEM_IDS = ITEMS.map((i) => i.id), consist = {};
  for (const r of repeat) {
    const f = firstMap[key(r)]; if (!f) continue;
    const c = (consist[r.rater_email] = consist[r.rater_email] || { n: 0, exact: 0, items: 0, diff: 0 });
    c.n++;
    let same = 0;
    for (const k of ITEM_IDS) if (r[k] === f[k]) same++;
    c.items += same; c.exact += same === ITEM_IDS.length ? 1 : 0;
    c.diff += Math.abs(scoreOf(r).total - scoreOf(f).total);
  }
  const consistency = Object.entries(consist).map(([email, c]) => ({
    email, n: c.n, item_match: r2(c.items / (c.n * ITEM_IDS.length)),
    exact_rate: r2(c.exact / c.n), mean_abs_diff: r2(c.diff / c.n) }));

  const usage = ITEMS.map((it) => {
    const max = it.type === "binary" ? 1 : 3;
    const counts = Array.from({ length: max + 1 }, () => 0);
    for (const r of first) if (Number.isInteger(r[it.id])) counts[r[it.id]]++;
    const n = counts.reduce((a, b) => a + b, 0) || 1;
    return { id: it.id, name: it.name, layer: it.layer, counts, rates: counts.map((c) => r2(c / n)) };
  });

  return json({ max: { l1: LAYER_MAX[1], l2: LAYER_MAX[2], l3: LAYER_MAX[3], total: TOTAL_MAX },
    n_responses: first.length, n_repeat: repeat.length, videos, raters, consistency, usage });
}

function csvCell(v) { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function csvResponse(cols, rows, filename) {
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  return text("\uFEFF" + lines.join("\n"), 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"` });
}

// ---------- API ----------
async function handleApi(pathname, request, env, db) {
  const m = request.method;

  if (pathname === "/api/items" && m === "GET")
    return json({ version: ITEMS_VERSION, items: ITEMS, layer_label: LAYER_LABEL, pre: PRE_QUESTIONS });
  if (pathname === "/api/bootstrap/status" && m === "GET") return await apiSetupStatus(db, env);
  if (pathname === "/api/bootstrap" && m === "POST") return await apiSetup(db, env, request);

  if (pathname === "/api/login" && m === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const email = String(d.email || "").trim().toLowerCase();
    if (!(await tablesExist(db))) return json({ error: "not_initialized" }, 503);
    const row = await db.prepare("SELECT * FROM raters WHERE email=?1").bind(email).first();
    if (!row || !row.active) return json({ error: "invalid" }, 401);
    if ((await pwHash(String(d.password || ""), row.pw_salt)) !== row.pw_hash) return json({ error: "invalid" }, 401);
    return json({ ok: true, role: row.role }, 200,
      { "set-cookie": cookieHeader(encodeURIComponent(await makeToken(env, email)), SESSION_DAYS * 86400) });
  }
  if (pathname === "/api/logout" && m === "POST")
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });

  const user = await getUser(db, env, request);
  if (!user) return json({ error: "unauthorized" }, 401);

  if (pathname === "/api/me" && m === "GET")
    return json({ email: user.email, name: user.name, role: user.role });

  if (pathname === "/api/tasks" && m === "GET") {
    await buildTasks(db, user);
    const tasks = (await db.prepare(
      `SELECT t.position,t.video_id,t.is_repeat,v.url,v.embed_url,
              (SELECT 1 FROM responses r WHERE r.rater_email=t.rater_email AND r.position=t.position) AS done
         FROM tasks t JOIN videos v ON v.id=t.video_id
        WHERE t.rater_email=?1 ORDER BY t.position`).bind(user.email).all()).results || [];
    const pre = await db.prepare("SELECT 1 x FROM surveys WHERE rater_email=?1 AND kind='pre'").bind(user.email).first();
    return json({ name: user.name || user.email, block_size: Number(await setting(db, "block_size", "25")),
      pre_done: !!pre, tasks: tasks.map((t) => ({ ...t, done: !!t.done })) });
  }

  if (pathname === "/api/response" && m === "POST") {
    if ((await setting(db, "open", "1")) !== "1") return json({ error: "closed" }, 403);
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const pos = Number(d.position);
    const t = await db.prepare("SELECT video_id FROM tasks WHERE rater_email=?1 AND position=?2").bind(user.email, pos).first();
    if (!t) return json({ error: "no_task" }, 404);
    const vals = [];
    for (const it of ITEMS) {
      const max = it.type === "binary" ? 1 : 3, n = Number(d[it.id]);
      if (!Number.isInteger(n) || n < 0 || n > max) return json({ error: "range:" + it.id }, 400);
      vals.push(n);
    }
    const ms = Number.isFinite(Number(d.elapsed_ms)) ? Math.round(Number(d.elapsed_ms)) : null;
    const now = nowIso();
    await db.prepare(
      `INSERT INTO responses (rater_email,position,video_id,q1,q2,q3,q4,q5,q6,q7,q8,elapsed_ms,items_version,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)
       ON CONFLICT(rater_email,position) DO UPDATE SET
         q1=?4,q2=?5,q3=?6,q4=?7,q5=?8,q6=?9,q7=?10,q8=?11,
         elapsed_ms=?12,items_version=?13,updated_at=?14`
    ).bind(user.email, pos, t.video_id, ...vals, ms, ITEMS_VERSION, now).run();
    return json({ ok: true });
  }

  if (pathname === "/api/survey" && m === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    await db.prepare(
      `INSERT INTO surveys (rater_email,kind,block,payload,updated_at) VALUES (?1,?2,?3,?4,?5)
       ON CONFLICT(rater_email,kind,block) DO UPDATE SET payload=?4,updated_at=?5`
    ).bind(user.email, d.kind === "recall" ? "recall" : "pre", Number(d.block) || 0,
      JSON.stringify(d.payload || {}), nowIso()).run();
    return json({ ok: true });
  }

  if (!pathname.startsWith("/api/admin/")) return json({ error: "not_found" }, 404);
  if (user.role !== "admin") return json({ error: "forbidden" }, 403);

  if (pathname === "/api/admin/raters" && m === "GET")
    return json({ raters: (await db.prepare(
      `SELECT r.email,r.name,r.role,r.active,r.seed,
              (SELECT COUNT(*) FROM tasks t WHERE t.rater_email=r.email) AS n_tasks,
              (SELECT COUNT(*) FROM responses x WHERE x.rater_email=r.email) AS n_done
         FROM raters r ORDER BY r.role DESC, r.email`).all()).results || [] });

  if (pathname === "/api/admin/rater" && m === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const email = String(d.email || "").trim().toLowerCase();
    if (!email.includes("@")) return json({ error: "bad_email" }, 400);
    const role = d.role === "admin" ? "admin" : "rater";
    const active = d.active === 0 || d.active === false ? 0 : 1;
    if (email === user.email && (role !== "admin" || active === 0)) return json({ error: "self_lockout" }, 400);
    const exists = await db.prepare("SELECT email FROM raters WHERE email=?1").bind(email).first();
    if (!exists) {
      const pw = String(d.password || "");
      if (pw.length < 8) return json({ error: "weak_password" }, 400);
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      await db.prepare(`INSERT INTO raters (email,name,role,pw_salt,pw_hash,seed,active,created_at)
                        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`)
        .bind(email, String(d.name || ""), role, salt, await pwHash(pw, salt),
          crypto.getRandomValues(new Uint32Array(1))[0], active, nowIso()).run();
    } else {
      await db.prepare("UPDATE raters SET name=?2,role=?3,active=?4 WHERE email=?1")
        .bind(email, String(d.name || ""), role, active).run();
      if (d.password) {
        if (String(d.password).length < 8) return json({ error: "weak_password" }, 400);
        const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
        await db.prepare("UPDATE raters SET pw_salt=?2,pw_hash=?3 WHERE email=?1")
          .bind(email, salt, await pwHash(String(d.password), salt)).run();
      }
    }
    return json({ ok: true });
  }

  if (pathname === "/api/admin/rebuild" && m === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const email = String(d.email || "").toLowerCase();
    const r = await db.prepare("SELECT email,seed FROM raters WHERE email=?1").bind(email).first();
    if (!r) return json({ error: "not_found" }, 404);
    const done = await db.prepare("SELECT COUNT(*) n FROM responses WHERE rater_email=?1").bind(email).first();
    if (done && done.n > 0 && !d.force) return json({ error: "has_responses", n: done.n }, 409);
    return json({ ok: true, n: await buildTasks(db, r, true) });
  }

  if (pathname === "/api/admin/videos" && m === "GET")
    return json({ videos: (await db.prepare("SELECT * FROM videos ORDER BY id").all()).results || [] });

  if (pathname === "/api/admin/import" && m === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!Array.isArray(d.videos)) return json({ error: "no_videos" }, 400);
    if (d.replace) await db.prepare("DELETE FROM videos").run();
    const st = db.prepare(
      `INSERT INTO videos (id,student_id,student_name,url,embed_url,award,url_status,active)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
       ON CONFLICT(id) DO UPDATE SET student_id=?2,student_name=?3,url=?4,embed_url=?5,
         award=?6,url_status=?7,active=?8`);
    const batch = d.videos.map((v, i) => st.bind(
      String(v.id || "v" + String(i + 1).padStart(3, "0")), String(v.student_id || ""),
      String(v.student_name || ""), String(v.url || ""), String(v.embed_url || toEmbed(v.url)),
      String(v.award || ""), String(v.url_status || ""), v.active === 0 || v.active === false ? 0 : 1));
    for (let i = 0; i < batch.length; i += 40) await db.batch(batch.slice(i, i + 40));
    return json({ ok: true, n: d.videos.length });
  }

  if (pathname === "/api/admin/video" && m === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!d.id) return json({ error: "missing:id" }, 400);
    await db.prepare("UPDATE videos SET active=?2 WHERE id=?1").bind(String(d.id), d.active ? 1 : 0).run();
    return json({ ok: true });
  }

  if (pathname === "/api/admin/settings") {
    if (m === "GET") {
      const rows = (await db.prepare("SELECT key,value FROM settings").all()).results || [];
      return json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
    }
    let d; try { d = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    for (const [k, v] of Object.entries(d))
      await db.prepare("INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2")
        .bind(String(k), String(v)).run();
    return json({ ok: true });
  }

  if (pathname === "/api/admin/progress" && m === "GET") return await apiProgress(db);

  if (pathname === "/api/admin/export.csv" && m === "GET")
    return csvResponse(
      ["rater_email", "position", "is_repeat", "video_id", "student_id", "student_name",
        "q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "elapsed_ms", "items_version", "updated_at"],
      (await db.prepare(
        `SELECT r.rater_email,r.position,t.is_repeat,r.video_id,v.student_id,v.student_name,
                r.q1,r.q2,r.q3,r.q4,r.q5,r.q6,r.q7,r.q8,r.elapsed_ms,r.items_version,r.updated_at
           FROM responses r
           JOIN tasks t ON t.rater_email=r.rater_email AND t.position=r.position
           LEFT JOIN videos v ON v.id=r.video_id
          ORDER BY r.rater_email,r.position`).all()).results || [], "responses.csv");

  if (pathname === "/api/admin/surveys.csv" && m === "GET")
    return csvResponse(["rater_email", "kind", "block", "payload", "updated_at"],
      (await db.prepare("SELECT * FROM surveys ORDER BY rater_email,kind,block").all()).results || [], "surveys.csv");

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!env.DB) return json({ error: "no_db", detail: "D1 バインディング DB が未設定です" }, 500);
      try {
        return await handleApi(url.pathname, request, env, env.DB);
      } catch (e) {
        return json({ error: "server", detail: String(e) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
