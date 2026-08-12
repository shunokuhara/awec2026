-- 動画評価実験 — D1 初期スキーマ
-- 設計方針:
--  * 評価者は測定モデルの推定対象（厳しさ・識別力）なので、必ず個人単位で識別する。
--  * 提示順は評価者ごとに固定して tasks に materialize する。順序効果を後から統制できる。
--  * 追加のみ。既存列の変更・削除はしない。

CREATE TABLE IF NOT EXISTS raters (
  email         TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'rater',   -- rater | admin
  pw_salt       TEXT NOT NULL,
  pw_hash       TEXT NOT NULL,
  seed          INTEGER NOT NULL,                -- 提示順の乱数シード
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id            TEXT PRIMARY KEY,                -- v001 ...
  student_id    TEXT,                            -- 学籍番号
  student_name  TEXT,
  url           TEXT NOT NULL,
  embed_url     TEXT,                            -- iframe 用（Drive の /preview 等）
  award         TEXT DEFAULT '',
  url_status    TEXT DEFAULT '',                 -- 統合時のURL判定
  active        INTEGER NOT NULL DEFAULT 1       -- 0 なら出題しない
);

-- 評価者ごとの出題リスト。position は 0 起点の通し番号。
CREATE TABLE IF NOT EXISTS tasks (
  rater_email   TEXT NOT NULL,
  position      INTEGER NOT NULL,
  video_id      TEXT NOT NULL,
  is_repeat     INTEGER NOT NULL DEFAULT 0,      -- 1 なら再現性チェック用の重複提示
  PRIMARY KEY (rater_email, position)
);

-- 回答。1 (rater, position) につき 1 行。
CREATE TABLE IF NOT EXISTS responses (
  rater_email   TEXT NOT NULL,
  position      INTEGER NOT NULL,
  video_id      TEXT NOT NULL,
  q1 INTEGER, q2 INTEGER, q3 INTEGER, q4 INTEGER,
  q5 INTEGER, q6 INTEGER, q7 INTEGER, q8 INTEGER,
  elapsed_ms    INTEGER,                         -- 動画表示から送信までの時間
  items_version TEXT,
  created_at    TEXT,
  updated_at    TEXT,
  PRIMARY KEY (rater_email, position)
);

-- 事前アンケート・セッション後の自由再生
CREATE TABLE IF NOT EXISTS surveys (
  rater_email   TEXT NOT NULL,
  kind          TEXT NOT NULL,                   -- pre | recall
  block         INTEGER NOT NULL DEFAULT 0,      -- recall のときのブロック番号
  payload       TEXT NOT NULL,                   -- JSON
  updated_at    TEXT,
  PRIMARY KEY (rater_email, kind, block)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO settings (key,value) VALUES ('block_size','25');
INSERT OR IGNORE INTO settings (key,value) VALUES ('repeat_count','10');
INSERT OR IGNORE INTO settings (key,value) VALUES ('open','1');

CREATE INDEX IF NOT EXISTS idx_tasks_rater ON tasks(rater_email);
CREATE INDEX IF NOT EXISTS idx_responses_video ON responses(video_id);
