# OMETSUKE — お目付け役

カメラで「作業姿勢の維持度」を見守り、ポモドーロを完走すると小判がもらえるゲーミフィケーション Web アプリのプロトタイプです。

## コンセプト

- やる気が出ないときの「着席して始める」ハードルを、見られている感 + 報酬で下げます。
- カメラで測れるのは集中そのものではなく代理指標 (在席・顔の向き) なので、「集中度」ではなく **作業姿勢の維持度** を測るゲームと割り切っています。
- スコアはセッション中に見せず、終了後にまとめて表示します (数字稼ぎプレイの防止)。

## 使い方

ビルド不要の静的ページです。`getUserMedia` はセキュアコンテキスト (https または localhost) が必要なので、ローカルサーバー経由で開いてください。

```bash
cd ometsuke
python3 -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

1. お勤めの長さ (15 / 25 / 45 分) を選んで「お勤め開始」。
2. 3 秒間のキャリブレーション中は、いつもの作業姿勢のままでいてください。この姿勢が「作業ゾーン」の基準になります (手元の本を見る姿勢でも OK)。
3. セッション中は顔の向きが基準から大きくずれる、または離席すると「よそ見 / 離席」判定になります。3 秒以内に戻れば減点されません。
4. 完走すると小判 3 枚 + 集中率ボーナス (70% 以上 +1、90% 以上 +2)。中断は 0 枚です。

## 仕組み

- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) (Tasks Vision, WASM) をブラウザ内で実行します。
- 顔変換行列から顔の正面ベクトルを取り、ヨー・ピッチのずれ (ヨー ±25°、ピッチ ±20°) で作業ゾーン内かを判定します。
- 映像は端末内でのみ処理し、保存・送信は一切しません。記録 (小判・履歴) は localStorage です。
- タブを裏に回すと検知が止まり、離席と同じ扱いになります。

## テスト

Playwright + ヘッドレス Chromium + 疑似カメラで、セッション完走までの一連のロジックとエラー フォールバックを検証します。

```bash
uv venv .venv && uv pip install --python .venv/bin/python playwright
.venv/bin/playwright install chromium --with-deps
.venv/bin/python test_app.py
```

## 公開 (GitHub Pages)

すべて相対パスの静的ページなので、GitHub Pages にそのまま置けます。https 配信のため `getUserMedia` もそのまま動きます。

1. GitHub で公開リポジトリ `ometsuke` を空のまま作成します (README・.gitignore なし)。
2. Vault リポジトリからこのフォルダだけを履歴つきで切り出して push します。

```bash
cd <vault リポジトリ>
git subtree split --prefix=ometsuke -b ometsuke-main
git push git@github.com:<ユーザー名>/ometsuke.git ometsuke-main:main
git branch -D ometsuke-main
```

3. 新リポジトリの Settings → Pages → Source を「Deploy from a branch」、Branch を `main` / `(root)` に設定します。
4. 数分後に `https://<ユーザー名>.github.io/ometsuke/` で公開されます。

## 制限 (プロトタイプ)

- モデルと WASM は CDN (jsdelivr / Google) から読み込むため、初回はネットワークが必要です。
- スマホ・タブレットは未検証です (PC ブラウザ想定)。
- しきい値は `app.js` 冒頭の `CONFIG` で調整できます。
