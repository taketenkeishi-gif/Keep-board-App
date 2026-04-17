# Keep Board

ボード型メモアプリです。  
Windows では `run_desktop.bat` 1本で更新・リビルド・起動できます。

## Windows 起動

- `run_desktop.bat`
  - `npm install`
  - `npm run tauri:build`
  - `src-tauri/target/release/keep-board.exe` を起動

## 主要機能

- 画像/動画/リンク/テキストカード
- サブボード
- 外部ドラッグ＆ドロップ
- PDF ドラッグ＆ドロップ
  - ドロップ位置を基準に新規サブボードを作成
  - PDF の各ページを画像カード化して自動整列

## 開発コマンド

```powershell
npm.cmd install
npm.cmd run dev
```

```powershell
npm.cmd run tauri:dev
```

