# Keep Board

カードを自由配置できるデスクトップボードアプリです。  
画像・動画・メモ・リンク・サブボードを1つのキャンバスで管理できます。

## ダウンロード（まずここ）

配布版は **GitHub Releases** から取得してください。  
`Setup.exe` を実行するだけで、インストール先ディレクトリが自動作成されます。

- Releases: `https://github.com/taketenkeishi-gif/Keep-board-App/releases`

推奨ファイル:

1. `Keep-Board-vX.Y.Z-Setup.exe`（推奨）
2. `Keep-Board-vX.Y.Z-Installer.msi`
3. `Keep-Board-vX.Y.Z-Portable.exe`（インストールなし）

## 配布方針

配布ポリシーの詳細は以下を参照してください。

- [Distribution Policy](docs/DISTRIBUTION_POLICY.md)

要点:

1. エンドユーザー向け導線は `Setup.exe` を第一優先にする
2. `run-built-app.bat` は開発・検証用
3. ソースZIPを配布導線にしない（実行ファイル同梱ではないため）

## 開発（ローカル）

```powershell
npm.cmd install
npm.cmd run dev
```

## デスクトップ開発（Tauri）

```powershell
npm.cmd run tauri:dev
```

## 本番ビルド

```powershell
npm.cmd run tauri:build
```

## Windows配布物をまとめて作成

```powershell
npm.cmd run release:win
```

出力先:

- `release/Keep-Board-vX.Y.Z/`

## GitHubリリース（自動）

タグ `vX.Y.Z` を push すると、GitHub Actions が Windows/macOS の成果物をビルドして Release に添付します。

Workflow:

- `.github/workflows/release.yml`
