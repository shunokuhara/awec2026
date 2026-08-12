# 動画評価実験アプリ（videoeval）

大学院生が約100本の動画を評価し、IRT の推定にかけられる形で回答を集めるためのアプリ。
Cloudflare Workers + D1。AGEWEC 本体（`agewec-site` / `agewec_2026`）とは**別の Worker・別の D1**で、
互いに干渉しない。Cloudflare Access は使わず、メールアドレス + パスワードでログインする。

```
/          ログイン
/setup/    初期化（1回だけ。スキーマ作成と初期データ投入）
/admin/    管理画面（評価者、動画、スコアのモニタリング、CSV出力）
/evaluate/ 評価画面（事前アンケート → Q1-Q8 × 全動画 → セッションごとの自由再生）
```

## 立ち上げ（ダッシュボードだけで完結する）

ローカルの wrangler は不要。GitHub に push してあれば以下で動く。

1. **D1 を作る** … Cloudflare ダッシュボード → Storage & Databases → D1 → Create。名前は `videoeval`。
   表示された **Database ID** を `wrangler.jsonc` の `REPLACE_WITH_D1_ID` に貼って commit する。
2. **Worker を作る** … Workers & Pages → Create → Import a repository → このリポジトリを選ぶ。
   `wrangler.jsonc` を読んでビルドされる。以後は push で自動デプロイ。
3. **シークレットを設定** … Worker の Settings → Variables and Secrets に2つ追加する。

   | 名前 | 値 |
   |---|---|
   | `SESSION_SECRET` | Cookie の署名鍵。長いランダム文字列 |
   | `BOOTSTRAP_TOKEN` | `/setup/` で使う合言葉。初期化が済んだら削除してよい |

4. **初期化** … `https://videoeval.<アカウント名>.workers.dev/setup/` を開き、`BOOTSTRAP_TOKEN` を入力。
   テーブルが作られ、管理者1名・評価者8名・動画96本が入る。
5. **ログイン** … `/` から。ログイン情報は `CREDENTIALS.md`。

URL は Cloudflare が払い出す `workers.dev` のもので足りる。独自ドメインは要らない。

## 初期データ

`worker/seed.js` に埋め込んである。`/setup/` を1回実行したときだけ投入される。

- 管理者1名（shunokuhara@icloud.com）
- 評価者8名（下浦・齋藤・日下・鈴木・長谷川・野瀬・蓑島・湖出）
- 動画96本。うち URL の形式から視聴できないと判断した9本は出題対象外（`active = 0`）

実際に評価するのが5名なら、参加しない3名は管理画面で「停止」にする。
再提出が届いた動画は管理画面のチェックボックスで出題対象に戻す。

名簿や動画を変えるときは `seed/*.json` を編集し、`worker/seed.js` を作り直す。
初期化済みの D1 には反映されないので、その場合は管理画面から追加・修正する。

## 評価項目

`worker/index.js` 冒頭の `ITEMS` が唯一の出典。評価画面はここから生成される。
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

## バックアップ

```bash
wrangler d1 export videoeval --remote --output videoeval-$(date +%F).sql
```

実験期間中は定期的に取っておくこと。

## テスト

D1 と静的アセットを模したハーネスで、Worker のロジックを手元で回せる。

```bash
node --experimental-sqlite test/harness.mjs
```

初期化、ログイン、権限、出題順、範囲チェック、モニタリング集計、CSV まで通しで検証する。

## リポジトリの公開範囲

`seed/videos.json` と `worker/seed.js` に学生の学籍番号と氏名、パスワードのハッシュが入る。
**リポジトリは private にすること。** `CREDENTIALS.md`（平文のパスワード）は `.gitignore` 済み。
