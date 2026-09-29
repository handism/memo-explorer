# Memo Explorer

VS Code / Cursorのサイドバーから、PC共通のMarkdownメモを作成・参照・編集する拡張機能です。既存のObsidian Vaultも保存先に指定できます。外部サービスや実行時の追加ライブラリは使用しません。

## インストール

1. [GitHub Releasesの最新版](https://github.com/handism/memo-explorer/releases/latest) から `memo-explorer-<バージョン>.vsix` をダウンロードします。cloneやNode.jsのインストールは不要です。
2. VS Code / Cursorの拡張機能画面の「…」から **VSIXからのインストール** を選択します。
3. 左側のノートアイコンを開くと **MEMO EXPLORER** が表示されます。

VS Code 1.85以降が対象です。初回起動時に `~/Documents/memo` を自動作成します。Remote SSH / WSL使用時もローカル側で動く設計です。

## 使い方

- タイトルバー：新規メモ、今日のデイリーノート、新規フォルダ、再読み込み、ファイル名検索、全文検索。
- 新規メモ：名前に拡張子がなければ `.md` を追加し、作成したファイルをエディタで開きます。`ideas/アイデア` のように `/` で区切るとサブフォルダも自動作成します。同名ファイルは上書きせず、既存のメモを開くか選べます。
- デイリーノート：ローカル時刻の今日の日付で `.md` を作成します。作成先は `memoExplorer.dailyFolder` で指定でき（初期値はルート直下）、フォルダがなければ自動作成します。日付書式に `/` を含めると `Daily/2026/09/2026-09-29.md` のように年・月フォルダへ振り分けます。既存ノートがあれば本文を変更せず開きます。
- サブフォルダ内への作成：対象フォルダを右クリックして作成します。タイトルバー・コマンドパレットからの作成先はルートです。
- 右クリック：名前の変更、確認後にゴミ箱へ移動（複数選択時はまとめて移動）、Finder / Explorer / OSのファイルマネージャーで表示。
- ドラッグ&ドロップ：ファイル・フォルダをフォルダへドロップして移動します。Cmd/Ctrl・Shiftで複数選択してまとめて移動できます。ファイルへのドロップはそのファイルと同じフォルダ、空白部分へのドロップはルートへの移動です。移動先の同名ファイルは上書きせず、フォルダをそれ自身の中へ移動することもできません。開いているエディタは移動先に追従します。
- 検索：全サブフォルダのメモを対象に、ファイル名と相対パスを入力して絞り込みます。Enterで開きます。
- 全文検索：保存先内の全メモ本文を大文字・小文字を区別せずに検索し、一致した行を一覧表示します（最大200件、2MB超のファイルは対象外）。Enterで該当行を開きます。
- 自動選択：エディタで保存先内のメモを開くと、ツリービューで該当ファイルを選択表示します（`memoExplorer.autoReveal` で無効化可能）。
- アイコン：VS Codeのファイルアイコンテーマ（Seti、Material Icon Themeなど）をツリーにも適用します。
- Obsidianなどで追加・削除されたファイルは自動反映します（本文の変更ではツリーを再読み込みしません）。手動で再読み込みもできます。

### ショートカットキー

| キー（macOSはControl+Option） | 操作 |
| --- | --- |
| `Ctrl+Alt+D` | 今日のデイリーノート |
| `Ctrl+Alt+N` | 新規メモ作成 |
| `Ctrl+Alt+M` | メモを検索（ファイル名） |
| `Ctrl+Alt+Shift+F` | メモ本文を全文検索 |
| `Ctrl+Alt+E` | MEMO EXPLORERにフォーカス |

macOSでは `Cmd+Option+D`（Dockの表示切替）などがOSに使われているため、全OS共通で `Ctrl+Alt` を使います。キーボードショートカット設定から変更できます。

`.md`、`.markdown`、`.txt`、設定したデフォルト拡張子を表示します（大文字の拡張子にも対応）。`.obsidian`などのドットで始まるファイル・フォルダ、画像などの添付ファイル、シンボリックリンクは一覧・検索から除外します。保存先自体をシンボリックリンクにすることは可能です。

ゴミ箱が使えない環境ではエラーを表示し、永久削除へ自動的に切り替えません。ファイル名・フォルダ名にはWindowsの予約文字・予約名や `..` を使用できません。

## 設定

VS Codeのユーザー設定で変更します。PC共通のためワークスペース設定では上書きしません。設定した保存先が変わると監視も切り替えます。以前のフォルダ内のメモは移動しません。

| 設定 | 初期値 | 内容 |
| --- | --- | --- |
| `memoExplorer.storagePath` | `~/Documents/memo` | 絶対パスまたはホーム相対パス。Windowsでは `C:\\Users\\name\\Documents\\memo` など |
| `memoExplorer.defaultExtension` | `.md` | 新規メモの拡張子。`txt`のようなドット省略にも対応 |
| `memoExplorer.dateFormat` | `YYYY-MM-DD` | `YYYY`、`YY`、`MM`、`M`、`DD`、`D`。固定文字は `[Daily]` のように囲む。`YYYY/MM/YYYY-MM-DD` のように `/` で区切るとサブフォルダに振り分け |
| `memoExplorer.dailyFolder` | 空文字 | デイリーノートの作成先。保存先からの相対パス（例: `Daily`、`日記/2026`）。空欄ならルート直下 |
| `memoExplorer.dailyTemplate` | 空文字 | 新規デイリーノートにだけ挿入する本文 |
| `memoExplorer.autoReveal` | `true` | エディタで開いたメモをツリーで自動選択 |

テンプレートでは次の変数を置換します。

| 変数 | 例 | 内容 |
| --- | --- | --- |
| `{{date}}` | `2026-09-29` | 設定した日付書式 |
| `{{isoDate}}` | `2026-09-29` | `YYYY-MM-DD` |
| `{{year}}` / `{{month}}` / `{{day}}` | `2026` / `09` / `29` | 年・月・日（月日は2桁） |
| `{{time}}` | `14:30` | 作成時刻（24時間表記） |
| `{{weekday}}` | `火` / `Tue` | VS Codeの表示言語での曜日 |
| `{{title}}` | `2026-09-29` | ファイル名（拡張子・フォルダなし） |

```json
{
  "memoExplorer.storagePath": "~/Documents/My Vault",
  "memoExplorer.dateFormat": "YYYY/MM/YYYY-MM-DD",
  "memoExplorer.dailyFolder": "Daily",
  "memoExplorer.dailyTemplate": "# {{title}}（{{weekday}}）\n\n## メモ\n\n## TODO\n- [ ] \n"
}
```

## 開発・検証

開発にはNode.js 22以降とnpmを使用します。

```sh
npm ci
npm test
npm run typecheck
npm run format:check   # 整形は npm run format
npm run package
```

GitHub Actions（`.github/workflows/ci.yml`）がpush・PRごとに整形チェック、型チェック、単体テスト、統合テスト（xvfb）、VSIX生成を実行し、VSIXをartifactとして保存します。

### リリース手順

1. `package.json` の `version` を上げてコミットし、mainへpushします（タグ作成は不要）。
2. CIのテストが通ると、`v<version>` のGitHub Releaseが未作成の場合に限り、タグ付きでReleaseを作成して `memo-explorer-<version>.vsix` を添付します。リリースノートは自動生成です。

VS Codeでこのフォルダを開き、F5で開発用ウィンドウを起動できます。

```sh
npm run test:integration
```

統合テストはVS Codeをダウンロードして、一時ユーザーデータ・一時メモフォルダで実行します。通常の設定やメモには触れません。インストール済みVS Codeを使用する場合：

```sh
VSCODE_EXECUTABLE_PATH='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm run test:integration
```

単体テストはパス・名前・日付・テンプレート変数、日付フォルダ、サブフォルダ付きファイル名、階層と表示対象、全文検索、移動先の判定、重複作成防止、既存本文保持、リンクの除外を検証します。統合テストは実際のExtension Hostで、起動・コマンドとキーバインド登録・エディタ表示・デイリーノート（日付フォルダを含む）・自動選択・アイコンテーマ適用・ドラッグ&ドロップによる複数移動・外部作成/削除・本文変更時に再読み込みしないこと・保存先と監視の切り替えを検証します。

手動確認の対象は、新規作成/リネームの入力UI、削除確認とOSのゴミ箱、Finder/Explorer表示、検索・全文検索の入力操作、ショートカットキーの実押下、Cursor、Windows/Linux、Remote環境です。

実装は [VS Code Extension API](https://code.visualstudio.com/api/references/vscode-api) を使用し、VSIXは公式の [vsce](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) で生成します。Marketplaceへの公開・自動インストールは行いません。
