# Memo Explorer

VS Code / Cursorのサイドバーから、PC共通のMarkdownメモを作成・参照・編集する拡張機能です。既存のObsidian Vaultも保存先に指定できます。外部サービスや実行時の追加ライブラリは使用しません。

## インストール

1. `memo-explorer-0.1.0.vsix`を用意します（このプロジェクトでは `npm ci` → `npm run package` で生成できます）。
2. VS Code / Cursorの拡張機能画面の「…」から **VSIXからのインストール** を選択します。
3. 左側のノートアイコンを開くと **MEMO EXPLORER** が表示されます。

VS Code 1.85以降が対象です。初回起動時に `~/Documents/memo` を自動作成します。Remote SSH / WSL使用時もローカル側で動く設計です。

## 使い方

- タイトルバー：新規メモ、今日のデイリーノート、新規フォルダ、再読み込み、検索。
- 新規メモ：名前に拡張子がなければ `.md` を追加し、作成したファイルをエディタで開きます。同名ファイルは上書きしません。
- デイリーノート：ローカル時刻の今日の日付でルート直下に `.md` を作成します。既存ノートがあれば本文を変更せず開きます。
- サブフォルダ内への作成：対象フォルダを右クリックして作成します。タイトルバー・コマンドパレットからの作成先はルートです。
- 右クリック：名前の変更、確認後にゴミ箱へ移動、Finder / Explorer / OSのファイルマネージャーで表示。
- 検索：全サブフォルダのメモを対象に、ファイル名と相対パスを入力して絞り込みます。Enterで開きます。
- Obsidianなどで追加・変更・削除されたファイルは自動反映します。手動で再読み込みもできます。

`.md`、`.markdown`、`.txt`、設定したデフォルト拡張子を表示します（大文字の拡張子にも対応）。`.obsidian`などのドットで始まるファイル・フォルダ、画像などの添付ファイル、シンボリックリンクは一覧・検索から除外します。保存先自体をシンボリックリンクにすることは可能です。

ゴミ箱が使えない環境ではエラーを表示し、永久削除へ自動的に切り替えません。日付書式・ファイル名にはフォルダ区切りやWindowsの予約文字・予約名を使用できません。

## 設定

VS Codeのユーザー設定で変更します。PC共通のためワークスペース設定では上書きしません。設定した保存先が変わると監視も切り替えます。以前のフォルダ内のメモは移動しません。

| 設定 | 初期値 | 内容 |
| --- | --- | --- |
| `memoExplorer.storagePath` | `~/Documents/memo` | 絶対パスまたはホーム相対パス。Windowsでは `C:\\Users\\name\\Documents\\memo` など |
| `memoExplorer.defaultExtension` | `.md` | 新規メモの拡張子。`txt`のようなドット省略にも対応 |
| `memoExplorer.dateFormat` | `YYYY-MM-DD` | `YYYY`、`YY`、`MM`、`M`、`DD`、`D`。固定文字は `[Daily]` のように囲む |
| `memoExplorer.dailyTemplate` | 空文字 | 新規デイリーノートにだけ挿入する本文 |

テンプレートの `{{date}}` は設定した日付書式、`{{isoDate}}` は `YYYY-MM-DD` に置換します。

```json
{
  "memoExplorer.storagePath": "~/Documents/My Vault",
  "memoExplorer.dateFormat": "YYYY-MM-DD",
  "memoExplorer.dailyTemplate": "# {{date}}\n\n## メモ\n\n## TODO\n- [ ] \n"
}
```

## 開発・検証

開発にはNode.js 22以降とnpmを使用します。

```sh
npm ci
npm test
npm run package
```

VS Codeでこのフォルダを開き、F5で開発用ウィンドウを起動できます。

```sh
npm run test:integration
```

統合テストはVS Codeをダウンロードして、一時ユーザーデータ・一時メモフォルダで実行します。通常の設定やメモには触れません。インストール済みVS Codeを使用する場合：

```sh
VSCODE_EXECUTABLE_PATH='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm run test:integration
```

単体テストはパス・名前・日付・テンプレート、階層と表示対象、重複作成防止、既存本文保持、リンクの除外を検証します。統合テストは実際のExtension Hostで、起動・コマンド登録・エディタ表示・デイリーノート・外部作成/変更/削除・保存先と監視の切り替えを検証します。

手動確認の対象は、新規作成/リネームの入力UI、削除確認とOSのゴミ箱、Finder/Explorer表示、検索の入力操作、Cursor、Windows/Linux、Remote環境です。

実装は [VS Code Extension API](https://code.visualstudio.com/api/references/vscode-api) を使用し、VSIXは公式の [vsce](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) で生成します。Marketplaceへの公開・自動インストールは行いません。
