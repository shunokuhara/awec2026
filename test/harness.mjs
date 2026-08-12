// D1 と ASSETS を模したテスト用ハーネス。本番では使わない。
// node --experimental-sqlite test/harness.mjs
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");

// ---- D1 shim ----
function bindArgs(sql, args) {
  // D1 は ?1..?N。node:sqlite に数値名パラメータを渡すためオブジェクトに変換する。
  const nums = [...new Set((sql.match(/\?(\d+)/g) || []).map((s) => Number(s.slice(1))))];
  if (!nums.length) return args;
  const o = {};
  for (const n of nums) o[String(n)] = args[n - 1] === undefined ? null : args[n - 1];
  return [o];
}
class Stmt {
  constructor(db, sql, args = null) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  _prep() {
    const s = this.db.prepare(this.sql);
    return { s, a: this.args ? bindArgs(this.sql, this.args) : [] };
  }
  async first() { const { s, a } = this._prep(); const r = s.get(...a); return r === undefined ? null : r; }
  async all() { const { s, a } = this._prep(); return { results: s.all(...a), success: true }; }
  async run() { const { s, a } = this._prep(); s.run(...a); return { success: true }; }
}
class D1 {
  constructor(file) { this.db = new DatabaseSync(file); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try { const out = []; for (const st of stmts) out.push(await st.run()); this.db.exec("COMMIT"); return out; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript" };
const ASSETS = {
  async fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, "public", p);
    if (!fs.existsSync(f)) return new Response("not found", { status: 404 });
    return new Response(fs.readFileSync(f), { headers: { "content-type": MIME[path.extname(f)] || "text/plain" } });
  },
};

const DBFILE = path.join(ROOT, "test", "test.db");
fs.rmSync(DBFILE, { force: true });
const env = { DB: new D1(DBFILE), ASSETS, SESSION_SECRET: "testsecret", BOOTSTRAP_TOKEN: "opensesame" };

// ---- テスト補助 ----
const BASE = "https://videoeval.test";
let failures = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? " OK " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};
const jar = {};
async function call(method, p, { body, as } = {}) {
  const headers = { "content-type": "application/json" };
  if (as && jar[as]) headers.cookie = jar[as];
  const res = await worker.fetch(new Request(BASE + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const sc = res.headers.get("set-cookie");
  if (sc && as) jar[as] = sc.split(";")[0];
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, data };
}

// ---- 1. 初期化前 ----
console.log("\n== 初期化 ==");
ok((await call("GET", "/api/bootstrap/status")).data.initialized === false, "初期化前は initialized=false");
ok((await call("POST", "/api/login", { body: { email: "a@b.c", password: "x" } })).status === 503,
  "初期化前のログインは 503");
ok((await call("POST", "/api/bootstrap", { body: { token: "wrong" } })).status === 401, "誤ったトークンは 401");

const boot = await call("POST", "/api/bootstrap", { body: { token: "opensesame" } });
ok(boot.status === 200, "初期化が成功", JSON.stringify(boot.data));
ok(boot.data.raters === 9 && boot.data.videos === 96, "評価者9名・動画96本を投入");
ok((await call("POST", "/api/bootstrap", { body: { token: "opensesame" } })).status === 409, "2回目は 409");
ok((await call("GET", "/api/bootstrap/status")).data.initialized === true, "初期化後は initialized=true");

// ---- 2. ログイン ----
console.log("\n== ログイン ==");
const creds = [];
for (const line of fs.readFileSync(path.join(ROOT, "CREDENTIALS.md"), "utf8").split("\n")) {
  const m = line.match(/\|\s*(\S+@\S+)\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`/);
  if (m) creds.push({ email: m[1], name: m[2], password: m[3] });
}
ok(creds.length === 9, `CREDENTIALS.md から9件読めた`, `${creds.length}件`);
for (const c of creds) {
  const r = await call("POST", "/api/login", { body: { email: c.email, password: c.password }, as: c.email });
  ok(r.status === 200, `ログイン ${c.name}`, r.data.role || JSON.stringify(r.data));
}
const admin = creds[0].email, rater = creds[1].email;
ok((await call("POST", "/api/login", { body: { email: admin, password: "wrong" } })).status === 401, "誤パスワードは 401");
ok((await call("GET", "/api/tasks")).status === 401, "未ログインは 401");
ok((await call("GET", "/api/admin/raters", { as: rater })).status === 403, "評価者が管理APIを叩くと 403");

// ---- 3. 出題リスト ----
console.log("\n== 出題リスト ==");
const t1 = await call("GET", "/api/tasks", { as: rater });
const tasks = t1.data.tasks;
ok(tasks.length === 97, "97件（有効87本 + 重複10本）", `${tasks.length}件`);
ok(tasks.filter((x) => x.is_repeat).length === 10, "重複提示が10件");
ok(new Set(tasks.map((x) => x.position)).size === tasks.length, "position が重複していない");
const t1b = await call("GET", "/api/tasks", { as: rater });
ok(JSON.stringify(t1b.data.tasks.map((x) => x.video_id)) === JSON.stringify(tasks.map((x) => x.video_id)),
  "再取得しても順序が変わらない");
const orders = [];
for (const c of creds.slice(1, 5)) orders.push((await call("GET", "/api/tasks", { as: c.email })).data.tasks.map((x) => x.video_id).join());
ok(new Set(orders).size === orders.length, "評価者ごとに提示順が違う");

// ---- 4. 回答 ----
console.log("\n== 回答 ==");
ok((await call("POST", "/api/response", { as: rater, body: { position: 0, q1: 4, q2: 0, q3: 0, q4: 0, q5: 0, q6: 0, q7: 0, q8: 0 } })).data.error === "range:q1",
  "q1 に 4 を入れると弾かれる");
ok((await call("POST", "/api/response", { as: rater, body: { position: 0, q1: 0, q2: 2, q3: 0, q4: 0, q5: 0, q6: 0, q7: 0, q8: 0 } })).data.error === "range:q2",
  "q2 に 2 を入れると弾かれる（二値）");
ok((await call("POST", "/api/response", { as: rater, body: { position: 9999, q1: 0, q2: 0, q3: 0, q4: 0, q5: 0, q6: 0, q7: 0, q8: 0 } })).status === 404,
  "存在しない position は 404");

let seedN = 12345;
const rnd = () => ((seedN = (seedN * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
let posted = 0;
for (const c of creds.slice(1, 4)) {
  await call("POST", "/api/survey", { as: c.email, body: { kind: "pre", block: 0, payload: { p1: 0, p2: 1 } } });
  for (let pos = 0; pos < 60; pos++) {
    const b = { position: pos, elapsed_ms: Math.floor(2000 + rnd() * 50000) };
    for (let q = 1; q <= 8; q++) b["q" + q] = q === 2 ? Math.floor(rnd() * 2) : Math.floor(rnd() * 4);
    const r = await call("POST", "/api/response", { as: c.email, body: b });
    if (r.data.ok) posted++;
  }
}
ok(posted === 180, "180件の回答が保存された", `${posted}件`);
const again = await call("POST", "/api/response", { as: rater, body: { position: 0, q1: 1, q2: 1, q3: 1, q4: 1, q5: 1, q6: 1, q7: 1, q8: 1 } });
ok(again.data.ok === true, "同じ position への再送は上書きされる");

// ---- 5. モニタリング ----
console.log("\n== モニタリング ==");
const mon = (await call("GET", "/api/admin/progress", { as: admin })).data;
ok(mon.max.total === 22, "合計の満点が 22");
ok(mon.n_responses + mon.n_repeat === 180, "初回+重複=180", `${mon.n_responses}+${mon.n_repeat}`);
const scored = mon.videos.filter((v) => v.n);
ok(scored.length > 0, `集計対象の動画 ${scored.length}本`);
ok(scored.every((v) => v.total >= 0 && v.total <= 22), "合計点が 0-22 の範囲");
ok(scored.every((v) => v.l1 <= 7 && v.l2 <= 9 && v.l3 <= 6), "各層が満点を超えない");
ok(mon.raters.length === 3, "評価者3名分の集計", `${mon.raters.length}名`);
ok(mon.usage.length === 8, "使用率が8項目分");
ok(mon.usage[1].counts.length === 2, "q2 は2カテゴリ");
ok(mon.usage[0].counts.length === 4, "q1 は4カテゴリ");

// ---- 6. 管理操作 ----
console.log("\n== 管理操作 ==");
ok((await call("POST", "/api/admin/rater", { as: admin, body: { email: admin, role: "rater" } })).data.error === "self_lockout",
  "自分の管理者権限は落とせない");
ok((await call("POST", "/api/admin/rater", { as: admin, body: { email: "new@x.jp", name: "追加", password: "short" } })).data.error === "weak_password",
  "短いパスワードは弾かれる");
ok((await call("POST", "/api/admin/rater", { as: admin, body: { email: "new@x.jp", name: "追加", password: "longenough1" } })).data.ok === true,
  "評価者を追加できる");
ok((await call("POST", "/api/login", { body: { email: "new@x.jp", password: "longenough1" } })).status === 200,
  "追加した評価者でログインできる");
ok((await call("POST", "/api/admin/rebuild", { as: admin, body: { email: rater } })).status === 409,
  "回答済みの出題リスト再生成は確認を求める");
ok((await call("POST", "/api/admin/rebuild", { as: admin, body: { email: rater, force: true } })).data.n === 97,
  "force なら再生成できる");
const vids = (await call("GET", "/api/admin/videos", { as: admin })).data.videos;
ok(vids.length === 96 && vids.filter((v) => v.active).length === 87, "動画96本/出題対象87本");
ok((await call("POST", "/api/admin/video", { as: admin, body: { id: "v001", active: false } })).data.ok === true, "動画を出題対象から外せる");
ok((await call("POST", "/api/admin/settings", { as: admin, body: { block_size: "20" } })).data.ok === true, "設定を保存できる");
ok((await call("GET", "/api/admin/settings", { as: admin })).data.settings.block_size === "20", "設定が反映される");

// ---- 7. CSV と静的ページ ----
console.log("\n== CSV / 静的ページ ==");
const csv = await call("GET", "/api/admin/export.csv", { as: admin });
const lines = String(csv.data).trim().split("\n");
ok(lines.length === 181, "CSV は 180行 + ヘッダ", `${lines.length}行`);
ok(lines[0].includes("rater_email") && lines[0].includes("is_repeat") && lines[0].includes("q8"), "CSV のヘッダが正しい");
ok((await call("GET", "/api/admin/surveys.csv", { as: admin })).status === 200, "アンケートCSVが出る");
for (const p of ["/", "/setup/", "/admin/", "/evaluate/", "/styles.css"]) {
  const r = await worker.fetch(new Request(BASE + p), env);
  ok(r.status === 200, `静的 ${p}`);
}

console.log(`\n${failures === 0 ? "すべて通過" : failures + " 件失敗"}`);
process.exit(failures ? 1 : 0);
