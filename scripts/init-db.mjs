// 初期データ入りの SQLite を作る。
// seed/admins.json, seed/raters.json, seed/videos.json を読んで、
// スキーマ適用 → 管理者・評価者の登録（パスワード自動生成）→ 動画の取り込み まで行う。
//
//   node --experimental-sqlite scripts/init-db.mjs                  # seed/videoeval.db を作る
//   node --experimental-sqlite scripts/init-db.mjs --out data/videoeval.db
//   node --experimental-sqlite scripts/init-db.mjs --reset          # 既存アカウントのパスワードも作り直す
//
// Node 24 以降は --experimental-sqlite なしで動く。
// パスワードの一覧は CREDENTIALS.md に書き出す（.gitignore 済み。配布したら削除すること）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto as crypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const RESET = argv.includes("--reset");
const outIdx = argv.indexOf("--out");
const OUT = path.resolve(ROOT, outIdx >= 0 ? argv[outIdx + 1] : "seed/videoeval.db");

const enc = new TextEncoder();
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => new Uint8Array((s.match(/../g) || []).map((x) => parseInt(x, 16)));

async function pwHash(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unhex(saltHex), iterations: 100000, hash: "SHA-256" }, key, 256);
  return hex(bits);
}

// 紛らわしい文字（0 O 1 l I）を除いた文字種。口頭やメールで伝えても取り違えにくい。
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makePassword = (len) =>
  Array.from(crypto.getRandomValues(new Uint32Array(len)), (n) => ALPHABET[n % ALPHABET.length]).join("");

function toEmbed(url) {
  const u = String(url || "");
  let m = u.match(/drive\.google\.com\/file\/d\/([^/]+)/); if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  m = u.match(/drive\.google\.com\/open\?id=([^&]+)/); if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/); if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = u.match(/vimeo\.com\/(\d+)/); if (m) return `https://player.vimeo.com/video/${m[1]}`;
  return "";
}

const readSeed = (f) => {
  const p = path.join(ROOT, "seed", f);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : [];
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const db = new DatabaseSync(OUT);
db.exec("PRAGMA journal_mode = DELETE;");   // 単一ファイルで持ち運べるよう WAL にしない
for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  db.exec(fs.readFileSync(path.join(ROOT, "migrations", f), "utf8"));
}

const issued = [];
async function upsertUser(email0, name, role, pwLen) {
  const email = String(email0).trim().toLowerCase();
  const existing = db.prepare("SELECT email FROM raters WHERE email=?").get(email);
  if (existing && !RESET) {
    db.prepare("UPDATE raters SET name=?, role=?, active=1 WHERE email=?").run(name, role, email);
    console.log(`既存: ${role.padEnd(5)} ${email}  ${name}`);
    return;
  }
  const password = makePassword(pwLen);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pwHash(password, salt);
  if (existing) {
    db.prepare("UPDATE raters SET name=?, role=?, active=1, pw_salt=?, pw_hash=? WHERE email=?")
      .run(name, role, salt, hash, email);
    console.log(`更新: ${role.padEnd(5)} ${email}  ${name}`);
  } else {
    db.prepare(`INSERT INTO raters (email,name,role,pw_salt,pw_hash,seed,active,created_at)
                VALUES (?,?,?,?,?,?,1,?)`)
      .run(email, name, role, salt, hash, crypto.getRandomValues(new Uint32Array(1))[0], new Date().toISOString());
    console.log(`登録: ${role.padEnd(5)} ${email}  ${name}`);
  }
  issued.push({ email, name, role, password });
}

// 管理者は権限が強いので長めにする
for (const a of readSeed("admins.json")) await upsertUser(a.email, a.name, "admin", 20);
for (const r of readSeed("raters.json")) await upsertUser(r.email, r.name, "rater", 12);

// 動画
const videos = readSeed("videos.json");
if (videos.length) {
  const st = db.prepare(
    `INSERT INTO videos (id,student_id,student_name,url,embed_url,award,url_status,active)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET student_id=excluded.student_id,student_name=excluded.student_name,
       url=excluded.url,embed_url=excluded.embed_url,award=excluded.award,
       url_status=excluded.url_status,active=excluded.active`);
  db.exec("BEGIN");
  videos.forEach((v, i) => st.run(
    String(v.id || "v" + String(i + 1).padStart(3, "0")), String(v.student_id || ""),
    String(v.student_name || ""), String(v.url || ""), String(v.embed_url || toEmbed(v.url)),
    String(v.award || ""), String(v.url_status || ""), v.active === 0 || v.active === false ? 0 : 1));
  db.exec("COMMIT");
  const on = db.prepare("SELECT COUNT(*) n FROM videos WHERE active=1").get().n;
  console.log(`動画: ${videos.length}本を取り込み（出題対象 ${on}本）`);
}

if (issued.length) {
  const md = [
    "# ログイン情報",
    "",
    "このファイルは配布用です。渡し終えたら削除してください。`.gitignore` 済み。",
    "",
    "## 管理者",
    "",
    "| メールアドレス | 氏名 | パスワード |",
    "|---|---|---|",
    ...issued.filter((x) => x.role === "admin").map((x) => `| ${x.email} | ${x.name} | \`${x.password}\` |`),
    "",
    "## 評価者",
    "",
    "| メールアドレス | 氏名 | パスワード |",
    "|---|---|---|",
    ...issued.filter((x) => x.role === "rater").map((x) => `| ${x.email} | ${x.name} | \`${x.password}\` |`),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(ROOT, "CREDENTIALS.md"), md);
  console.log(`\nログイン情報: CREDENTIALS.md（${issued.length}件）`);
} else {
  console.log("\n新しくパスワードを発行したアカウントはありません。CREDENTIALS.md は更新していません。");
}
console.log(`DB: ${OUT}`);
