# Memo Explorer

VS Code / Cursorのサイドバーから、PC共通のMarkdownメモを作成・参照・編集する拡張機能です。既存のObsidian Vaultも保存先に指定できます。外部サービスや実行時の追加ライブラリは使用しません。詳しい仕様は [SPEC.md](SPEC.md) を参照してください。

## インストール

1. [GitHub Releasesの最新版](https://github.com/handism/memo-explorer/releases/latest) から `memo-explorer-<バージョン>.vsix` をダウンロードします。
2. VS Code / Cursorの拡張機能画面の「…」から **VSIXからのインストール** を選択します。
3. 左側のノートアイコンを開くと **MEMO EXPLORER** が表示されます。

VS Code 1.85以降が対象です。初回起動時に `~/Documents/memo` を自動作成します。Remote SSH / WSL使用時もローカル側で動きます。

## 主な機能

- **新規メモ・フォルダ**：`ideas/アイデア` のように `/` で区切るとサブフォルダも作成します。同名ファイルは上書きしません。フォルダを右クリックするとその中に作成します。
- **デイリーノート**：今日の日付のメモを作成して開きます。作成先フォルダ・日付書式・テンプレートを設定できます。
- **整理**：右クリックで名前の変更、ゴミ箱へ移動、Finder / Explorerで表示。ドラッグ&ドロップで移動（複数選択可）。Finder / Explorerからのドロップはコピーして取り込みます。
- **ブックマーク**：右クリックやドラッグで **ブックマーク** ビューに追加し、ドラッグで並べ替えます。名前の変更・移動にも追従します。
- **検索**：ファイル名検索、全文検索（大文字・小文字を区別しない）、フロントマターの `tags` によるタグ検索。
- **メタデータの自動付与**（macOS・Apple Intelligence 対応機のみ）：右クリックで本文から `tags` と `summary` を生成し、フロントマターに追加します。生成は端末内の Apple Foundation Models（`/usr/bin/fm`）で行い、外部へ送信しません。フォルダ単位でまとめて付与することもできます。初回はターミナルで `fm license` を実行して利用規約に同意してください。
- **メタデータの消去**：フロントマターを `---` ごと消します（手書きのキーも消えます）。フォルダ単位でも実行できます。
- **その他**：開いているメモをツリーで自動選択、ファイルアイコンテーマの適用、Obsidianなど外部での追加・削除を自動反映。

表示対象は `.md`、`.markdown`、`.txt` と設定したデフォルト拡張子です。`.obsidian` などドットで始まるもの、添付ファイル、シンボリックリンクは除外します。

### ショートカットキー

| キー（macOSもControl+Option） | 操作 |
| --- | --- |
| `Ctrl+Alt+D` | 今日のデイリーノート |
| `Ctrl+Alt+N` | 新規メモ作成 |
| `Ctrl+Alt+M` | メモを検索（ファイル名） |
| `Ctrl+Alt+Shift+F` | メモ本文を全文検索 |
| `Ctrl+Alt+E` | MEMO EXPLORERにフォーカス |

## 設定

ユーザー設定で変更します（ワークスペース設定では上書きしません）。

| 設定 | 初期値 | 内容 |
| --- | --- | --- |
| `memoExplorer.storagePath` | `~/Documents/memo` | 保存先（絶対パスまたはホーム相対パス） |
| `memoExplorer.defaultExtension` | `.md` | 新規メモの拡張子 |
| `memoExplorer.dateFormat` | `YYYY-MM-DD` | `YYYY` `YY` `MM` `M` `DD` `D`。固定文字は `[Daily]` のように囲む。`/` で区切るとサブフォルダに振り分け |
| `memoExplorer.dailyFolder` | 空文字 | デイリーノートの作成先（保存先からの相対パス） |
| `memoExplorer.dailyTemplate` | 空文字 | 新規デイリーノートの本文 |
| `memoExplorer.autoReveal` | `true` | 開いたメモをツリーで自動選択 |

テンプレートでは `{{date}}`、`{{isoDate}}`、`{{year}}` / `{{month}}` / `{{day}}`、`{{time}}`、`{{weekday}}`、`{{title}}` を置換します。

```json
{
  "memoExplorer.storagePath": "~/Documents/My Vault",
  "memoExplorer.dateFormat": "YYYY/MM/YYYY-MM-DD",
  "memoExplorer.dailyFolder": "Daily",
  "memoExplorer.dailyTemplate": "# {{title}}（{{weekday}}）\n\n## メモ\n\n## TODO\n- [ ] \n"
}
```

### macOSでクラウドストレージを保存先にする場合

`~/Library/CloudStorage/...`（Dropbox、Google Driveなど）で `EPERM: operation not permitted` が出る場合は、**システム設定 > プライバシーとセキュリティ > フルディスクアクセス** でエディタをオンにして再起動してください。対象フォルダはFinderで「オフラインで使用可能にする」にしておくことを推奨します。

## 開発

Node.js 22以降とnpmを使用します。VS Codeでこのフォルダを開き、F5で開発用ウィンドウを起動できます。

```sh
npm ci
npm test                  # 単体テスト
npm run test:integration  # 統合テスト（一時ユーザーデータ・一時メモフォルダで実行）
npm run typecheck
npm run format:check      # 整形は npm run format
npm run package           # VSIX生成
```

CI（`.github/workflows/ci.yml`）がpush・PRごとに整形チェック、型チェック、単体テスト、統合テスト（Ubuntu・Windows・macOS）、VSIX生成を実行します。

**リリース**：`package.json` の `version` を上げてmainへpushすると、CI通過後に `v<version>` のGitHub Releaseを作成してVSIXを添付します（タグ作成は不要）。
