// 動画評価実験 — Node + SQLite サーバー
//
// 外部パッケージなし。Node 22 以降で動く（node:sqlite を使用）。
//   node --experimental-sqlite server.mjs      # Node 22 / 23
//   node server.mjs                            # Node 24 以降
//
// 環境変数:
//   PORT             既定 8787
//   DB_PATH          既定 ./data/videoeval.db
//   SESSION_SECRET   Cookie の署名鍵。必ず設定する
//
// 静的ファイルは ./public、スキーマは ./migrations/*.sql を起動時に流す。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto as crypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "videoeval.db");
const SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) console.warn("[警告] SESSION_SECRET が未設定です。本番では必ず設定してください。");
const SECRET = SESSION_SECRET || "dev-insecure-secret-change-me";

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

// ---------- DB ----------
// 初回起動時、DB がまだ無ければ seed/videoeval.db（管理者・評価者・動画を入れた初期データ）
// をコピーして使う。以後はコピー先だけを読み書きするので、初期データは上書きされない。
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const SEED_DB = path.join(ROOT, "seed", "videoeval.db");
if (!fs.existsSync(DB_PATH) && fs.existsSync(SEED_DB)) {
  fs.copyFileSync(SEED_DB, DB_PATH);
  console.log(`初期データをコピーしました: ${SEED_DB} -> ${DB_PATH}`);
}
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  db.exec(fs.readFileSync(path.join(ROOT, "migrations", f), "utf8"));
}
const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

// ---------- 小道具 ----------
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
async function hmac(msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
const SESSION_DAYS = 30;
async function makeToken(email) {
  const body = `${email}.${Date.now() + SESSION_DAYS * 86400000}`;
  return `${body}.${await hmac(body)}`;
}
async function readToken(token) {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const body = token.slice(0, i);
  if ((await hmac(body)) !== token.slice(i + 1)) return null;
  const j = body.lastIndexOf(".");
  if (!(Number(body.slice(j + 1)) > Date.now())) return null;
  return body.slice(0, j);
}

const setting = (k, d) => { const r = one("SELECT value FROM settings WHERE key=?", k); return r ? r.value : d; };

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

function buildTasks(rater, force = false) {
  if (!force && one("SELECT COUNT(*) n FROM tasks WHERE rater_email=?", rater.email).n > 0) return null;
  const blockSize = Number(setting("block_size", "25"));
  const repeatCount = Number(setting("repeat_count", "10"));
  const vids = all("SELECT id FROM videos WHERE active=1 ORDER BY id").map((r) => r.id);
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
  const tx = db.prepare("INSERT INTO tasks (rater_email,position,video_id,is_repeat) VALUES (?,?,?,?)");
  db.exec("BEGIN");
  try {
    run("DELETE FROM tasks WHERE rater_email=?", rater.email);
    seq.forEach((s, i) => tx.run(rater.email, i, s.v, s.r));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  void blockSize;
  return seq.length;
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

function monitoring() {
  const rows = all(`SELECT r.rater_email,r.position,r.video_id,r.elapsed_ms,
                           r.q1,r.q2,r.q3,r.q4,r.q5,r.q6,r.q7,r.q8,t.is_repeat
                      FROM responses r JOIN tasks t
                        ON t.rater_email=r.rater_email AND t.position=r.position`);
  const vids = all("SELECT id,student_id,student_name,active,url_status FROM videos ORDER BY id");
  const first = rows.filter((r) => !r.is_repeat), repeat = rows.filter((r) => r.is_repeat);

  const byVideo = {};
  for (const r of first) (byVideo[r.video_id] ||= []).push(scoreOf(r));
  const videos = vids.map((v) => {
    const s = byVideo[v.id] || [], tot = s.map((x) => x.total);
    return { id: v.id, student_id: v.student_id, student_name: v.student_name, active: v.active,
      url_status: v.url_status, n: s.length,
      l1: r2(mean(s.map((x) => x.l1))), l2: r2(mean(s.map((x) => x.l2))), l3: r2(mean(s.map((x) => x.l3))),
      total: r2(mean(tot)), total_sd: r2(sd(tot)),
      total_pct: s.length ? Math.round((100 * mean(tot)) / TOTAL_MAX) : null };
  });

  const byRater = {};
  for (const r of first) (byRater[r.rater_email] ||= []).push({ ...scoreOf(r), ms: r.elapsed_ms });
  const raters = Object.entries(byRater).map(([email, s]) => {
    const tot = s.map((x) => x.total);
    const ms = s.map((x) => x.ms).filter(Number.isFinite).sort((a, b) => a - b);
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
    const c = (consist[r.rater_email] ||= { n: 0, exact: 0, items: 0, diff: 0 });
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

  return { max: { l1: LAYER_MAX[1], l2: LAYER_MAX[2], l3: LAYER_MAX[3], total: TOTAL_MAX },
    n_responses: first.length, n_repeat: repeat.length, videos, raters, consistency, usage };
}

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const send = (res, status, body, headers = {}) => { res.writeHead(status, headers); res.end(body); };
const sendJson = (res, data, status = 200, headers = {}) =>
  send(res, status, JSON.stringify(data), { "content-type": "application/json; charset=utf-8", ...headers });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ""; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > 2e6) { reject(new Error("too_large")); req.destroy(); } b += c; });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}
async function jsonBody(req) { try { return JSON.parse(await readBody(req)); } catch { return null; } }

function cookieOf(req, name) {
  for (const p of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = p.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
async function getUser(req) {
  const email = await readToken(cookieOf(req, "ve_session"));
  if (!email) return null;
  const row = one("SELECT email,name,role,active,seed FROM raters WHERE email=?", email);
  return row && row.active ? row : null;
}
const cookieHeader = (v, maxAge, secure) =>
  `ve_session=${v}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, "public", path.normalize(p).replace(/^([/\\])+/, ""));
  if (!file.startsWith(path.join(ROOT, "public"))) return send(res, 403, "forbidden");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found", { "content-type": "text/plain; charset=utf-8" });
    send(res, 200, data, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  });
}

function csvCell(v) { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function sendCsv(res, cols, rows, filename) {
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  send(res, 200, "\uFEFF" + lines.join("\n"), {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"` });
}

async function handleApi(req, res, pathname) {
  const m = req.method;
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https");

  if (pathname === "/api/items" && m === "GET")
    return sendJson(res, { version: ITEMS_VERSION, items: ITEMS, layer_label: LAYER_LABEL, pre: PRE_QUESTIONS });

  if (pathname === "/api/bootstrap/status" && m === "GET")
    return sendJson(res, { initialized: one("SELECT COUNT(*) n FROM raters").n > 0 });

  if (pathname === "/api/bootstrap" && m === "POST") {
    if (one("SELECT COUNT(*) n FROM raters").n > 0) return sendJson(res, { error: "already_initialized" }, 409);
    const d = await jsonBody(req); if (!d) return sendJson(res, { error: "bad_json" }, 400);
    const email = String(d.email || "").trim().toLowerCase(), pw = String(d.password || "");
    if (!email.includes("@")) return sendJson(res, { error: "bad_email" }, 400);
    if (pw.length < 8) return sendJson(res, { error: "weak_password" }, 400);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    run(`INSERT INTO raters (email,name,role,pw_salt,pw_hash,seed,active,created_at)
         VALUES (?,?,'admin',?,?,?,1,?)`,
      email, String(d.name || "管理者"), salt, await pwHash(pw, salt),
      crypto.getRandomValues(new Uint32Array(1))[0], nowIso());
    return sendJson(res, { ok: true, email });
  }

  if (pathname === "/api/login" && m === "POST") {
    const d = await jsonBody(req); if (!d) return sendJson(res, { error: "bad_json" }, 400);
    const email = String(d.email || "").trim().toLowerCase();
    const row = one("SELECT * FROM raters WHERE email=?", email);
    if (!row || !row.active) return sendJson(res, { error: "invalid" }, 401);
    if ((await pwHash(String(d.password || ""), row.pw_salt)) !== row.pw_hash)
      return sendJson(res, { error: "invalid" }, 401);
    return sendJson(res, { ok: true, role: row.role }, 200,
      { "set-cookie": cookieHeader(encodeURIComponent(await makeToken(email)), SESSION_DAYS * 86400, secure) });
  }
  if (pathname === "/api/logout" && m === "POST")
    return sendJson(res, { ok: true }, 200, { "set-cookie": cookieHeader("", 0, secure) });

  const user = await getUser(req);
  if (!user) return sendJson(res, { error: "unauthorized" }, 401);

  if (pathname === "/api/me" && m === "GET")
    return sendJson(res, { email: user.email, name: user.name, role: user.role });

  if (pathname === "/api/tasks" && m === "GET") {
    buildTasks(user);
    const tasks = all(
      `SELECT t.position,t.video_id,t.is_repeat,v.url,v.embed_url,
              (SELECT 1 FROM responses r WHERE r.rater_email=t.rater_email AND r.position=t.position) AS done
         FROM tasks t JOIN videos v ON v.id=t.video_id
        WHERE t.rater_email=? ORDER BY t.position`, user.email);
    return sendJson(res, {
      name: user.name || user.email, block_size: Number(setting("block_size", "25")),
      pre_done: !!one("SELECT 1 x FROM surveys WHERE rater_email=? AND kind='pre'", user.email),
      tasks: tasks.map((t) => ({ ...t, done: !!t.done })) });
  }

  if (pathname === "/api/response" && m === "POST") {
    if (setting("open", "1") !== "1") return sendJson(res, { error: "closed" }, 403);
    const d = await jsonBody(req); if (!d) return sendJson(res, { error: "bad_json" }, 400);
    const pos = Number(d.position);
    const t = one("SELECT video_id FROM tasks WHERE rater_email=? AND position=?", user.email, pos);
    if (!t) return sendJson(res, { error: "no_task" }, 404);
    const vals = [];
    for (const it of ITEMS) {
      const max = it.type === "binary" ? 1 : 3, n = Number(d[it.id]);
      if (!Number.isInteger(n) || n < 0 || n > max) return sendJson(res, { error: "range:" + it.id }, 400);
      vals.push(n);
    }
    const ms = Number.isFinite(Number(d.elapsed_ms)) ? Math.round(Number(d.elapsed_ms)) : null;
    const now = nowIso();
    run(`INSERT INTO responses (rater_email,position,video_id,q1,q2,q3,q4,q5,q6,q7,q8,elapsed_ms,items_version,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(rater_email,position) DO UPDATE SET
           q1=excluded.q1,q2=excluded.q2,q3=excluded.q3,q4=excluded.q4,q5=excluded.q5,
           q6=excluded.q6,q7=excluded.q7,q8=excluded.q8,elapsed_ms=excluded.elapsed_ms,
           items_version=excluded.items_version,updated_at=excluded.updated_at`,
      user.email, pos, t.video_id, ...vals, ms, ITEMS_VERSION, now, now);
    return sendJson(res, { ok: true });
  }

  if (pathname === "/api/survey" && m === "POST") {
    const d = await jsonBody(req); if (!d) return sendJson(res, { error: "bad_json" }, 400);
    run(`INSERT INTO surveys (rater_email,kind,block,payload,updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(rater_email,kind,block) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`,
      user.email, d.kind === "recall" ? "recall" : "pre", Number(d.block) || 0,
      JSON.stringify(d.payload || {}), nowIso());
    return sendJson(res, { ok: true });
  }

  if (!pathname.startsWith("/api/admin/")) return sendJson(res, { error: "not_found" }, 404);
  if (user.role !== "admin") return sendJson(res, { error: "forbidden" }, 403);

  if (pathname === "/api/admin/raters" && m === "GET")
    return sendJson(res, { raters: all(
      `SELECT r.email,r.name,r.role,r.active,r.seed,
              (SELECT COUNT(*) FROM tasks t WHERE t.rater_email=r.email) AS n_tasks,
              (SELECT COUNT(*) FROM responses x WHERE x.rater_email=r.email) AS n_done
         FROM raters r ORDER BY r.role DESC, r.email`) });

  if (pathname === "/api/admin/rater" && m === "POST") {
    const d = await jsonBody(req); if (!d) return sendJson(res, { error: "bad_json" }, 400);
    const email = String(d.email || "").trim().toLowerCase();
    if (!email.includes("@")) return sendJson(res, { error: "bad_email" }, 400);
    const role = d.role === "admin" ? "admin" : "rater";
    const active = d.active === 0 || d.active === false ? 0 : 1;
    if (email === user.email && (role !== "admin" || active === 0)) return sendJson(res, { error: "self_lockout" }, 400);
    const exists = one("SELECT email FROM raters WHERE email=?", email);
    if (!exists) {
      const pw = String(d.password || "");
      if (pw.length < 8) return sendJson(res, { error: "weak_password" }, 400);
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      run(`INSERT INTO raters (email,name,role,pw_salt,pw_hash,seed,active,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        email, String(d.name || ""), role, salt, await pwHash(pw, salt),
        crypto.getRandomValues(new Uint32Array(1))[0], active, nowIso());
    } else {
      run("UPDATE raters SET name=?,role=?,active=? WHERE email=?", String(d.name || ""), role, active, email);
      if (d.password) {
        if (String(d.password).length < 8) return sendJson(res, { error: "weak_password" }, 400);
        const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
        run("UPDATE raters SET pw_salt=?,pw_hash=? WHERE email=?", salt, await pwHash(String(d.password), salt), email);
      }
    }
    return sendJson(res, { ok: true });
  }

  if (pathname === "/api/admin/rebuild" && m === "POST") {
    const d = await jsonBody(req); if (!d) return sendJson(res, { error: "bad_json" }, 400);
    const email = String(d.email || "").toLowerCase();
    const r = one("SELECT email,seed FROM raters WHERE email=?", email);
    if (!r) return sendJson(res, { error: "not_found" }, 404);
    const done = one("SELECT COUNT(*) n FROM responses WHERE rater_email=?", email).n;
    if (done > 0 && !d.force) return sendJson(res, { error: "has_responses", n: done }, 409);
    return sendJson(res, { ok: true, n: buildTasks(r, true) });
  }

  if (pathname === "/api/admin/videos" && m === "GET")
    return sendJson(res, { videos: all("SELECT * FROM videos ORDER BY id") });

  if (pathname === "/api/admin/import" && m === "POST") {
    const d = await jsonBody(req); if (!d) return sendJson(res, { error: "bad_json" }, 400);
    if (!Array.isArray(d.videos)) return sendJson(res, { error: "no_videos" }, 400);
    const st = db.prepare(
      `INSERT INTO videos (id,student_id,student_name,url,embed_url,award,url_status,active)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET student_id=excluded.student_id,student_name=excluded.student_name,
         url=excluded.url,embed_url=excluded.embed_url,award=excluded.award,
         url_status=excluded.url_status,active=excluded.active`);
    db.exec("BEGIN");
    try {
      if (d.replace) run("DELETE FROM videos");
      d.videos.forEach((v, i) => st.run(
        String(v.id || "v" + String(i + 1).padStart(3, "0")), String(v.student_id || ""),
        String(v.student_name || ""), String(v.url || ""), String(v.embed_url || toEmbed(v.url)),
        String(v.award || ""), String(v.url_status || ""), v.active === 0 || v.active === false ? 0 : 1));
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); return sendJson(res, { error: "import_failed", detail: String(e) }, 500); }
    return sendJson(res, { ok: true, n: d.videos.length });
  }

  if (pathname === "/api/admin/video" && m === "POST") {
    const d = await jsonBody(req); if (!d || !d.id) return sendJson(res, { error: "missing:id" }, 400);
    run("UPDATE videos SET active=? WHERE id=?", d.active ? 1 : 0, String(d.id));
    return sendJson(res, { ok: true });
  }

  if (pathname === "/api/admin/settings") {
    if (m === "GET") return sendJson(res, { settings: Object.fromEntries(all("SELECT key,value FROM settings").map((r) => [r.key, r.value])) });
    const d = await jsonBody(req); if (!d) return sendJson(res, { error: "bad_json" }, 400);
    for (const [k, v] of Object.entries(d))
      run("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(k), String(v));
    return sendJson(res, { ok: true });
  }

  if (pathname === "/api/admin/progress" && m === "GET") return sendJson(res, monitoring());

  if (pathname === "/api/admin/export.csv" && m === "GET")
    return sendCsv(res,
      ["rater_email", "position", "is_repeat", "video_id", "student_id", "student_name",
        "q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "elapsed_ms", "items_version", "updated_at"],
      all(`SELECT r.rater_email,r.position,t.is_repeat,r.video_id,v.student_id,v.student_name,
                  r.q1,r.q2,r.q3,r.q4,r.q5,r.q6,r.q7,r.q8,r.elapsed_ms,r.items_version,r.updated_at
             FROM responses r
             JOIN tasks t ON t.rater_email=r.rater_email AND t.position=r.position
             LEFT JOIN videos v ON v.id=r.video_id
            ORDER BY r.rater_email,r.position`), "responses.csv");

  if (pathname === "/api/admin/surveys.csv" && m === "GET")
    return sendCsv(res, ["rater_email", "kind", "block", "payload", "updated_at"],
      all("SELECT * FROM surveys ORDER BY rater_email,kind,block"), "surveys.csv");

  return sendJson(res, { error: "not_found" }, 404);
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || "/").split("?")[0];
  try {
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);
    return serveStatic(req, res, req.url || "/");
  } catch (e) {
    console.error(e);
    sendJson(res, { error: "server", detail: String(e) }, 500);
  }
});
server.listen(PORT, () => {
  const n = one("SELECT COUNT(*) n FROM raters").n;
  console.log(`videoeval http://localhost:${PORT}  (DB: ${DB_PATH})`);
  if (!n) console.log("管理者が未登録です。/setup/ を開いて最初の管理者を作成してください。");
});
