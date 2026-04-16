# Keep Board

Milanote 風のボードアプリです。  
Web 開発起動と Desktop(Tauri) 起動を分離し、Windows 用スクリプトを整理しました。

## 実行スクリプト（Windows）

- `web-dev.bat`  
  Web 版の開発サーバーを起動します（Vite / http://127.0.0.1:5173）。
- `desktop-dev.bat`  
  Desktop 版の開発起動（`tauri dev`）。
- `desktop-run-built.bat`  
  既存のビルド済み Desktop exe を起動します。exe が無い場合のみビルドします。
- `desktop-build-release.bat`  
  配布用ビルドを作成し、`release/Keep-Board-vX.Y.Z/` に成果物を出力します。

補足:

- 旧ファイル `start.bat` / `run-built-app.bat` / `build-release.bat` は互換ラッパーです。  
  新しい名前の BAT を呼び出します。
- 実体スクリプトは `scripts/windows/` 配下にあります。

## セットアップ EXE の配布先

- Releases 一覧: [GitHub Releases](https://github.com/taketenkeishi-gif/Keep-board-App/releases)
- 最新 Setup.exe 直リンク（最新版に更新されます）:  
  [Keep-Board-v0.2.8-Setup.exe](https://github.com/taketenkeishi-gif/Keep-board-App/releases/latest/download/Keep-Board-v0.2.8-Setup.exe)

## ローカル開発コマンド

```powershell
npm.cmd install
npm.cmd run dev
```

Desktop 開発:

```powershell
npm.cmd run tauri:dev
```

配布ビルド:

```powershell
npm.cmd run release:win
```

## リリース運用

1. `desktop-build-release.bat` で成果物作成
2. `vX.Y.Z` タグを push
3. GitHub Release に `Setup.exe / MSI / Portable.exe` を添付

