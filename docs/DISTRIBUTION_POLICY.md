# Distribution Policy

## Purpose

このドキュメントは、Keep Board の配布導線を統一し、ユーザーが迷わずインストールできる状態を維持するための方針です。

## Official Download Entry

公式ダウンロード窓口は **GitHub Releases** のみです。

- `https://github.com/taketenkeishi-gif/Keep-board-App/releases`

## Asset Priority

ユーザー向けに案内する順序:

1. `Setup.exe`（推奨）
2. `Installer.msi`
3. `Portable.exe`

## Why Setup First

- インストール先ディレクトリを自動作成できる
- デスクトップアプリとして最も一般的な導線
- `bat` 実行やソース配置に依存しない

## Non-Goal for End Users

以下はエンドユーザーの公式導線にしない:

- ソースZIPからの直接実行
- `run-built-app.bat` を前提にした案内

## Release Operations

1. バージョン更新
2. `vX.Y.Z` タグ作成
3. タグを push
4. GitHub Actions で Release アセット生成
