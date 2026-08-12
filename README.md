# 動画評価実験アプリ

大学院生5名で約100本の動画を評価し、IRT の推定にかけられる形で回答を集めるためのアプリ。
外部パッケージなし。Node 22 以降と SQLite だけで動く。特定のホスティング事業者に依存しない。

```
/          ログイン
/setup/    初期セットアップ（最初の管理者を1人だけ作る。作成後は閉じる）
/admin/    管理画面（評価者の追加、動画の取り込み、スコアのモニタリング、CSV出力）
/evaluate/ 評価画面（事前アンケート → Q1-Q8 × 全動画 → セッションごとの自由再生）
```

## 起動

```bash
git clone <このリポジトリ>
cd videoeval

export SESSION_SECRET="$(head -c 32 /dev/urandom | base64)"   # 必ず設定する
npm start                    # Node 22 / 23（--experimental-sqlite 付き）
# Node 24 以降なら: node server.mjs
```

`http://localhost:8787` が上がる。環境変数は3つだけ。

| 変数 | 既定 | 用途 |
|---|---|---|
| `PORT` | 8787 | 待ち受けポート |
| `DB_PATH` | `./data/videoeval.db` | SQLite ファイル |
| `SESSION_SECRET` | （なし） | Cookie の署名鍵。未設定だと警告が出る |

DB ファイルとスキーマは初回起動時に自動で作られる。`migrations/*.sql` は毎回流すが、
すべて `IF NOT EXISTS` なので何度実行しても問題ない。

## 立ち上げ手順

`seed/videoeval.db` に、管理者1名・評価者8名・動画96本を入れた初期データが同梱してある。
初回起動時に `data/videoeval.db` へ自動コピーされるので、セットアップ作業は要らない。

1. サーバーを起動する
2. `/` からログインする（ログイン情報は `CREDENTIALS.md`）

`/setup/` は管理者が既に登録済みなので閉じている。

初期データは以下のとおり。

- 管理者: shunokuhara@icloud.com
- 評価者: 8名（下浦・齋藤・日下・鈴木・長谷川・野瀬・蓑島・湖出）
- 動画: 96本。うち URL の形式から視聴できないと判断した9本は出題対象外（`active = 0`）

実際に評価するのが5名なら、参加しない3名は管理画面で「停止」にする。

### 初期データを作り直す

名簿（`seed/admins.json`, `seed/raters.json`）や動画（`seed/videos.json`）を編集したら、
次のコマンドで `seed/videoeval.db` を作り直す。

```bash
node --experimental-sqlite scripts/init-db.mjs
```

- 既に登録済みのアカウントは氏名の更新だけ行い、パスワードは変えない
- パスワードを作り直すときは `--reset` を付ける
- 発行したパスワードは `CREDENTIALS.md` に書き出される（`.gitignore` 済み）

稼働中の DB に直接反映したいときは `--out data/videoeval.db` を指定する。

### パスワードについて

自動生成の12文字（管理者は20文字）。`0 O 1 l I` のような紛らわしい文字は除いてあるので、
口頭やメールで伝えても取り違えにくい。

`seed/videoeval.db` にはパスワードのハッシュが入る。平文ではないが、**リポジトリは
private にすること**。公開リポジトリに置くなら、初期データを外して `/setup/` から
作る運用に戻すほうがよい。

## どこで動かすか

GitHub はコードを置く場所であって、サーバーではない。GitHub Pages は静的ファイルしか返せず、
このアプリは回答を保存するので動かない。実際に走らせる場所が別に要る。

**研究室のサーバー**が一番素直。systemd に登録すれば放っておける。

```ini
# /etc/systemd/system/videoeval.service
[Unit]
Description=videoeval
After=network.target

[Service]
WorkingDirectory=/opt/videoeval
Environment=PORT=8787
Environment=DB_PATH=/var/lib/videoeval/videoeval.db
Environment=SESSION_SECRET=<ランダムな文字列>
ExecStart=/usr/bin/node --experimental-sqlite server.mjs
Restart=always
User=videoeval

[Install]
WantedBy=multi-user.target
```

学外からアクセスさせるなら nginx などを前段に置いて HTTPS を終端する。学内だけで足りるなら
そのままでよい。Cookie の `Secure` 属性は `X-Forwarded-Proto: https` を見て自動で切り替わる。

**GitHub に push したら自動で反映されてほしい場合**は、Render / Railway / Fly.io などが
GitHub 連携に対応している。同梱の `Dockerfile` がそのまま使える。SQLite ファイルを置く
永続ボリューム（`/data`）が要るので、使う枠でボリュームが確保できるかは事前に確認すること。

```bash
docker build -t videoeval .
docker run -p 8787:8787 -v $PWD/data:/data -e SESSION_SECRET=... videoeval
```

## バックアップ

SQLite ファイル1つなのでコピーで済む。

```bash
sqlite3 data/videoeval.db ".backup backup-$(date +%F).db"
```

実験期間中は日次で取っておくこと。`data/` は `.gitignore` に入れてある。

## 評価項目

`server.mjs` 冒頭の `ITEMS` が唯一の出典。人間用の画面もここから生成される。
LLM 評価器に同じ項目を投げるときも、この定義から文言を起こすこと。1文字でもずれると
人間と AI を同一尺度に載せる前提が崩れる。

| | 層 | 項目 | 段階 |
|---|---|---|---|
| Q1 | 適格性 | 技術的破綻 | 0-3 |
| Q2 | 適格性 | 北九州市の識別 | 0-1 |
| Q3 | 適格性 | メッセージ明瞭性 | 0-3 |
| Q4 | 地域固有性 | 都市名の置換可能性 | 0-3 |
| Q5 | 地域固有性 | 観光情報の具体性 | 0-3 |
| Q6 | 地域固有性 | 知覚された独自性 | 0-3 |
| Q7 | 訴求力 | 訪問意欲 | 0-3 |
| Q8 | 訴求力 | 共有意向 | 0-3 |

項目を足すときは `ITEMS` に要素を追加し、`migrations/0002_*.sql` で `responses` に列を足す。

## 設計上の要点

- **提示順は評価者ごとに固定**。`raters.seed` から決定的に生成し、`tasks` に実体化する。
  順序効果を後から統制でき、中断しても同じ順序で再開する。
- **重複提示**（既定10本）を後半に混ぜる（`tasks.is_repeat = 1`）。評価者内一貫性の測定用。
  逆転項目を入れない代わりの検出手段。
- **回答時間**を `responses.elapsed_ms` に記録する。straightlining の検出に使う。
- 範囲チェックはサーバー側で行う。Q2 は 0-1、他は 0-3。
- 回答済みの評価者の出題リストを作り直すと対応が取れなくなるため、確認を挟む。

## モニタリング

管理画面に出る点数は進行状況を見るための集計であり、研究上の効用値ではない。

- 層1 = Q1+Q2+Q3（満点7）、層2 = Q4+Q5+Q6（満点9）、層3 = Q7+Q8（満点6）、合計22
- 重複提示分は二重に数えないよう除外している
- 評価者ごとの平均が甘辛の目安、選択肢の使用率が5%未満ならその選択肢は機能していない

効用値は CSV を落として、評価者ごとの厳しさと識別力を持つ一般化多相ラッシュモデルで別途推定する。

## 出力

- `/api/admin/export.csv` … rater_email, position, is_repeat, video_id, q1..q8, elapsed_ms
- `/api/admin/surveys.csv` … 事前アンケートと自由再生

CSV の1行が「評価者 × 動画」の1観測。IRT の推定にそのまま渡せる。

## 動画データ

`seed/videos.json` は提出一覧（96名分）から起こしたもの。URL の形式から視聴できないと
判断した9本は `active: 0` で入るので出題されない。再提出が届いたら管理画面のチェックボックスで
有効にする。埋め込み再生できるのは79本で、残りは別タブで開くリンク表示になる。
