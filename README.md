# NOIDA — 時間を、渡す。

社長の脳の外側に置く、もう一人の自分。

## セットアップ

### 1. 依存関係をインストール
```bash
npm install
```

### 2. 環境変数を設定
```bash
cp .env.local.example .env.local
```
`.env.local`を開いて、以下を設定：
- `ANTHROPIC_API_KEY` → AnthropicのAPIキー

### 3. 開発サーバーを起動
```bash
npm run dev
```

ブラウザで http://localhost:3000 を開く

## ファイル構成

```
noida/
├── app/
│   ├── api/chat/route.ts   ← Claude APIルート
│   ├── globals.css          ← グローバルスタイル
│   ├── layout.tsx           ← ルートレイアウト
│   └── page.tsx             ← メインページ
├── components/
│   ├── NoidaChat.tsx        ← チャットUI（メイン）
│   ├── NoidaHeader.tsx      ← ヘッダー
│   └── NoidaIcon.tsx        ← ロゴアイコン
├── lib/
│   └── types.ts             ← 型定義
├── .env.local.example       ← 環境変数テンプレート
└── package.json
```

## 次のステップ

1. Supabase連携（記憶・保存）
2. Gmail API（メール処理）
3. ダッシュボード画面
4. LINE通知連携
