import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  MemoStore,
  Entry,
  ExistsError,
  topLevel,
  storagePath,
  notePath,
  validateName,
  checkedName,
  dailyPath,
  dailyContent,
  folderSegments,
  hiddenRename,
  inside,
  addBookmarks,
  removeBookmarks,
  renameBookmarks,
  moveBookmarks
} from './core';

export class MemoTree implements vscode.TreeDataProvider<Entry>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Entry | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly status = new vscode.EventEmitter<string | undefined>();
  /** 読み込みに失敗するとエラー内容を、ルートを読み込めると undefined を通知する */
  readonly onDidChangeStatus = this.status.event;
  /** VS Code は要素をオブジェクトの同一性で識別するため、部分更新や reveal には getChildren で返したものと同じ Entry を渡す */
  private readonly entries = new Map<string, Entry>();
  private current?: MemoStore;
  /** ブックマーク済みか。右クリックメニューの「追加」「解除」の出し分けに使う */
  bookmarked: (target: string) => boolean = () => false;
  get store(): MemoStore | undefined {
    return this.current;
  }
  set store(store: MemoStore | undefined) {
    this.current = store;
    this.entries.clear();
  }
  refresh(): void {
    // 全体を読み直すと getChildren で作り直されるため、削除済みの項目を持ち越さない
    this.entries.clear();
    this.changed.fire(undefined);
  }
  /** フォルダの中身だけを読み直す。未表示のフォルダは次に展開したときに読まれるため何もしない */
  refreshFolder(folder: string): void {
    if (!this.store) return;
    // 大文字・小文字の違いなどで保存先の配下と判定できないパスは、取りこぼさないよう全体を読み直す
    if (path.resolve(folder) === this.store.root || !inside(this.store.root, folder)) return this.refresh();
    const entry = this.entries.get(folder);
    if (entry?.directory) this.changed.fire(entry);
  }
  /** 表示中の項目だけを描き直す。未表示の項目は次に表示したときに反映される */
  refreshItem(target: string): void {
    const entry = this.entries.get(target);
    if (entry) this.changed.fire(entry);
  }
  entry(target: string, directory: boolean): Entry {
    const existing = this.entries.get(target);
    if (existing?.directory === directory) return existing;
    const entry = { path: target, name: path.basename(target), directory };
    this.entries.set(target, entry);
    return entry;
  }
  getTreeItem(entry: Entry): vscode.TreeItem {
    const item = new vscode.TreeItem(
      entry.name,
      entry.directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.resourceUri = vscode.Uri.file(entry.path);
    item.id = entry.path;
    item.contextValue = (entry.directory ? 'memoFolder' : 'memoFile') + (this.bookmarked(entry.path) ? '.bookmarked' : '');
    if (!entry.directory) item.command = { command: 'vscode.open', title: 'メモを開く', arguments: [item.resourceUri, { preview: false }] };
    return item;
  }
  async getChildren(entry?: Entry): Promise<Entry[]> {
    if (!this.store) return [];
    try {
      const entries = await this.store.entries(entry?.path);
      if (!entry) this.status.fire(undefined);
      return entries.map(e => this.entry(e.path, e.directory));
    } catch (error) {
      this.status.fire(message(error));
      return [];
    }
  }
  getParent(entry: Entry): Entry | undefined {
    const parent = path.dirname(entry.path);
    return !this.store || parent === this.store.root || parent === entry.path ? undefined : this.entry(parent, true);
  }
  dispose(): void {
    this.changed.dispose();
    this.status.dispose();
  }
}
export interface Bookmark {
  path: string;
  directory: boolean;
  /** 外部での名前変更・削除などで見つからない。勝手に外さず、利用者が解除できるよう残しておく */
  missing: boolean;
}
export class BookmarkTree implements vscode.TreeDataProvider<Bookmark>, vscode.TreeDragAndDropController<Bookmark>, vscode.Disposable {
  /** v1.1 までの保存場所。ファイルがまだ無いときだけ引き継ぐ */
  private static readonly legacyKey = 'bookmarks';
  private static readonly mime = 'application/vnd.code.tree.memoexplorer.bookmarks';
  readonly dragMimeTypes = [BookmarkTree.mime];
  readonly dropMimeTypes = [BookmarkTree.mime];
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly items = new vscode.EventEmitter<string[]>();
  /** 追加・解除された項目を通知する。メモツリー側の右クリックメニューを描き直すのに使う */
  readonly onDidChangeItems = this.items.event;
  /** 表示する保存先。保存先を切り替えても、以前の保存先のブックマークは消さずに残す */
  root?: string;
  private list: string[] = [];
  /** 読み書きを1件ずつ順に行い、書き込み中の読み直しで古い一覧に戻らないようにする */
  private queue = Promise.resolve();
  /**
   * globalState は短い間隔で書き込むと古い値に巻き戻ることがあるため、拡張機能の保存フォルダの JSON に保存する。
   * 他のウィンドウでの変更を取りこぼさないよう、書き込む直前と表示のたびに読み直す
   */
  constructor(
    private readonly file: string,
    private readonly legacy?: vscode.Memento
  ) {}
  /** 追加順に並んだ、全保存先のブックマーク */
  get all(): string[] {
    return [...this.list];
  }
  has(target: string): boolean {
    return this.list.includes(path.resolve(target));
  }
  load(): Promise<void> {
    return this.enqueue(async () => void this.apply(await this.read(), false));
  }
  /** 変化した項目を返す */
  update(change: (list: string[]) => string[]): Promise<string[]> {
    return this.enqueue(async () => {
      const before = await this.read(),
        after = change(before);
      if (after.length !== before.length || after.some((b, i) => b !== before[i])) await this.write(after);
      return this.apply(after, true);
    });
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
  /** 表示中の一覧と比べて変化した項目を通知する */
  private apply(after: string[], refresh: boolean): string[] {
    const before = this.list;
    this.list = after;
    const diff = [...before.filter(b => !after.includes(b)), ...after.filter(b => !before.includes(b))];
    if (diff.length) this.items.fire(diff);
    if (refresh && (diff.length || after.some((b, i) => b !== before[i]))) this.refresh();
    return diff;
  }
  private async read(): Promise<string[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.legacy?.get<string[]>(BookmarkTree.legacyKey, []) ?? [];
    }
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string'))
      throw new Error(`ブックマークのファイルが壊れています。${this.file}`);
    return value as string[];
  }
  private async write(list: string[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    // 書き込み途中のファイルを他のウィンドウが読まないよう、別名で書いてから置き換える
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(list, undefined, 2));
    await fs.rename(temporary, this.file);
  }
  refresh(): void {
    this.changed.fire(undefined);
  }
  handleDrag(sources: readonly Bookmark[], data: vscode.DataTransfer): void {
    data.set(BookmarkTree.mime, new vscode.DataTransferItem(sources.map(b => b.path)));
  }
  /** ブックマーク同士の並べ替え。空白部分へのドロップは末尾へ移す */
  async handleDrop(target: Bookmark | undefined, data: vscode.DataTransfer): Promise<void> {
    const sources = data.get(BookmarkTree.mime)?.value as string[] | undefined;
    if (sources?.length) await this.update(list => moveBookmarks(list, sources, target?.path));
  }
  getTreeItem(bookmark: Bookmark): vscode.TreeItem {
    const relative = this.root ? path.relative(this.root, bookmark.path) : bookmark.path,
      folder = path.dirname(relative);
    const item = new vscode.TreeItem(path.basename(bookmark.path), vscode.TreeItemCollapsibleState.None);
    item.id = bookmark.path;
    item.resourceUri = vscode.Uri.file(bookmark.path);
    item.description = bookmark.missing ? '見つかりません' : folder === '.' ? undefined : folder;
    item.tooltip = bookmark.missing ? `${relative}（名前の変更・移動・削除されたため見つかりません）` : relative;
    item.contextValue = bookmark.missing ? 'memoBookmark.missing' : bookmark.directory ? 'memoBookmark.folder' : 'memoBookmark.file';
    if (bookmark.missing) item.iconPath = new vscode.ThemeIcon('warning');
    else if (bookmark.directory) {
      item.iconPath = vscode.ThemeIcon.Folder;
      item.command = { command: 'memo.showInTree', title: 'ツリーで表示', arguments: [bookmark] };
    } else item.command = { command: 'vscode.open', title: 'メモを開く', arguments: [item.resourceUri, { preview: false }] };
    return item;
  }
  async getChildren(bookmark?: Bookmark): Promise<Bookmark[]> {
    const root = this.root;
    if (bookmark || !root) return [];
    await this.load().catch(() => undefined);
    return Promise.all(
      this.list
        .filter(target => target !== root && inside(root, target))
        .map(async target => {
          const stat = await fs.lstat(target).catch(() => undefined);
          return { path: target, directory: !!stat?.isDirectory(), missing: !stat };
        })
    );
  }
  dispose(): void {
    this.changed.dispose();
    this.items.dispose();
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** 設定値の解釈に失敗したとき、どの設定が原因かをエラー文に添える */
function setting<T>(key: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new Error(`設定 memoExplorer.${key} が不正です。${message(error)}`, { cause: error });
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const tree = new MemoTree();
  const bookmarks = new BookmarkTree(path.join(context.globalStorageUri.fsPath, 'bookmarks.json'), context.globalState);
  tree.bookmarked = target => bookmarks.has(target);
  // メモツリーの右クリックメニュー（追加／解除）を追従させる
  context.subscriptions.push(bookmarks.onDidChangeItems(targets => targets.forEach(t => tree.refreshItem(t))));
  const updateBookmarks = (change: (list: string[]) => string[]) => bookmarks.update(change);
  const output = vscode.window.createOutputChannel('Memo Explorer');
  await bookmarks.load().catch((error: unknown) => output.appendLine(message(error)));
  let watcher: vscode.FileSystemWatcher | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready: Promise<void>;
  /** 保存先のファイルの作成・削除。全文検索が使い回すファイル一覧を捨てる合図にする */
  const filesChanged = new vscode.EventEmitter<void>();
  const config = () => vscode.workspace.getConfiguration('memoExplorer');
  const report = (error: unknown) => {
    output.appendLine(message(error));
    void vscode.window.showErrorMessage(`Memo Explorer: ${message(error)}`);
  };
  const mime = 'application/vnd.code.tree.memoexplorer.files';
  const uriList = 'text/uri-list';
  const dragAndDrop: vscode.TreeDragAndDropController<Entry> = {
    dragMimeTypes: [mime],
    dropMimeTypes: [mime, uriList],
    handleDrag(sources, data) {
      data.set(mime, new vscode.DataTransferItem(sources));
    },
    async handleDrop(target, data) {
      const sources = data.get(mime)?.value as Entry[] | undefined;
      // ツリー内のドラッグは移動、OSのファイルマネージャやエクスプローラーからのドロップはコピーとして取り込む
      const external = sources?.length
        ? []
        : ((await data.get(uriList)?.asString()) ?? '')
            .split(/\r?\n/)
            .filter(line => line && !line.startsWith('#'))
            .map(line => vscode.Uri.parse(line))
            .filter(uri => uri.scheme === 'file')
            .map(uri => uri.fsPath);
      if (!sources?.length && !external.length) return;
      try {
        await ready;
        const store = tree.store;
        if (!store) throw new Error('保存先の設定を確認してください。');
        const destination = !target ? store.root : target.directory ? target.path : path.dirname(target.path);
        if (sources?.length) {
          const moves = await store.planMove(sources, destination);
          if (!moves.length) return;
          const edit = new vscode.WorkspaceEdit();
          for (const move of moves) edit.renameFile(vscode.Uri.file(move.from), vscode.Uri.file(move.to), { overwrite: false });
          if (!(await vscode.workspace.applyEdit(edit))) throw new Error('移動できませんでした。同名ファイルなどを確認してください。');
        } else {
          const plan = await store.planCopy(external, destination);
          if (plan.files.length > 100) {
            const answer = await vscode.window.showWarningMessage(
              `${plan.files.length}件のメモを取り込みますか？`,
              { modal: true, detail: path.relative(store.root, destination) || path.basename(store.root) },
              '取り込む'
            );
            if (answer !== '取り込む') return;
          }
          let copied = 0;
          try {
            for (const folder of plan.folders) await vscode.workspace.fs.createDirectory(vscode.Uri.file(folder));
            for (const copy of plan.files) {
              await vscode.workspace.fs.copy(vscode.Uri.file(copy.from), vscode.Uri.file(copy.to), { overwrite: false });
              copied++;
            }
          } catch (error) {
            // 取り込み済みのメモは消さずに残すため、どこまで進んだかを伝える
            throw new Error(
              `${plan.files.length}件中${copied}件を取り込んだところで中断しました（取り込み済みのメモは残っています）。${message(error)}`,
              {
                cause: error
              }
            );
          } finally {
            tree.refresh();
          }
          if (plan.skipped)
            void vscode.window.showInformationMessage(
              `メモ以外の項目（隠しファイル・リンク・対応していない拡張子など）${plan.skipped}件は取り込みませんでした。`
            );
          return;
        }
        tree.refresh();
      } catch (error) {
        report(error);
      }
    }
  };
  const view = vscode.window.createTreeView('memoExplorer.files', {
    treeDataProvider: tree,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: dragAndDrop
  });
  const bookmarkView = vscode.window.createTreeView('memoExplorer.bookmarks', {
    treeDataProvider: bookmarks,
    canSelectMany: true,
    dragAndDropController: bookmarks
  });
  // ツリーの読み込みエラーは展開のたびに起き得るため、ダイアログではなくビュー上に表示する
  let failure: string | undefined;
  context.subscriptions.push(
    tree.onDidChangeStatus(error => {
      if (error === failure) return;
      if (error) output.appendLine(error);
      if (error || failure) view.message = error && `読み込めない項目があります。${error}`;
      failure = error;
    })
  );
  async function configure(): Promise<void> {
    const current = ++generation;
    watcher?.dispose();
    watcher = undefined;
    clearTimeout(timer);
    failure = undefined;
    tree.store = undefined;
    tree.refresh();
    bookmarks.root = undefined;
    bookmarks.refresh();
    view.message = '保存先を読み込み中…';
    try {
      // Windows ではファイル監視やエディタから届くパスのドライブレターが小文字になるため、
      // 同じ形に揃えておかないとツリーの項目と照合できない
      const store = new MemoStore(
        vscode.Uri.file(storagePath(config().get<string>('storagePath', '~/Documents/memo'))).fsPath,
        config().get<string>('defaultExtension', '.md')
      );
      await store.initialize();
      if (current !== generation) return;
      tree.store = store;
      bookmarks.root = store.root;
      bookmarks.refresh();
      view.description = store.root;
      view.message = undefined;
      watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(store.root), '**/*'));
      // 変化のあったフォルダだけを読み直す。.obsidian などの隠しフォルダ配下は一覧に出ないため無視する
      const folders = new Set<string>();
      const refresh = (uri: vscode.Uri) => {
        if (store.ignored(uri.fsPath)) return;
        filesChanged.fire();
        folders.add(path.dirname(uri.fsPath));
        clearTimeout(timer);
        timer = setTimeout(() => {
          for (const folder of folders) tree.refreshFolder(folder);
          folders.clear();
          // 外部で消えた・戻ってきたブックマークの表示を更新する
          bookmarks.refresh();
        }, 100);
      };
      watcher.onDidCreate(refresh);
      watcher.onDidDelete(refresh);
      tree.refresh();
      reveal();
    } catch (error) {
      if (current !== generation) return;
      view.message = `保存先を開けません。設定を確認して再読み込みしてください。${message(error)}`;
      report(error);
    }
  }
  let revealing = Promise.resolve();
  function reveal(editor = vscode.window.activeTextEditor): void {
    const store = tree.store,
      uri = editor?.document.uri;
    if (!store || !view.visible || uri?.scheme !== 'file' || !store.listed(uri.fsPath) || !config().get<boolean>('autoReveal', true))
      return;
    const target = uri.fsPath;
    revealing = revealing
      .then(async () => {
        // シンボリックリンク配下のメモはツリーに出ないため、表示を試みずに終える
        if (tree.store === store && (await store.visible(target)))
          await view.reveal(tree.entry(target, false), { select: true, focus: false });
      })
      .then(undefined, () => undefined);
  }
  const open = async (target: string, selection?: vscode.Range) =>
    vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(target)), { preview: false, selection });
  const register = (id: string, handler: (store: MemoStore, entry?: Entry, entries?: Entry[]) => Promise<unknown>) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (entry?: Entry, entries?: Entry[]) => {
        try {
          await ready;
          const store = tree.store;
          if (!store) throw new Error('保存先の設定を確認してください。');
          return await handler(store, entry, entries);
        } catch (error) {
          report(error);
        }
      })
    );
  };
  const selected = (entry?: Entry) => entry ?? view.selection[0];
  /** 右クリックした項目が複数選択に含まれていれば選択全体を、含まれていなければその項目だけを対象にする */
  const picked = <T extends { path: string }>(argument: T, all?: T[]) => (all?.some(e => e.path === argument.path) ? all : [argument]);
  /** コマンドパレットから実行したときは、エディタで開いているメモを対象にする */
  const activeNote = (store: MemoStore) => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'file' && store.listed(uri.fsPath) ? uri.fsPath : undefined;
  };
  /** 引数がなければツリーの選択を使い、ファイルが選ばれていればそのフォルダに作る */
  const directory = (store: MemoStore, argument?: Entry) => {
    const entry = selected(argument);
    return !entry ? store.root : entry.directory ? entry.path : path.dirname(entry.path);
  };
  async function choose(store: MemoStore, entry?: Entry): Promise<Entry | undefined> {
    if (entry) return entry;
    // 一覧の取得を待たずに開き、取得中はビジー表示にする
    const items = store
      .allFiles()
      .then(files => files.map(e => ({ label: e.name, description: path.relative(store.root, e.path), entry: e })));
    return (await vscode.window.showQuickPick(items, { placeHolder: 'メモファイル名を入力', matchOnDescription: true }))?.entry;
  }
  register('memo.createFile', async (store, entry) => {
    const name = await vscode.window.showInputBox({
      prompt: '新規メモのファイル名（/ 区切りでサブフォルダも作成）',
      placeHolder: 'アイデア.md または ideas/アイデア.md',
      validateInput: value => {
        try {
          notePath(value, store.defaultExtension);
          return undefined;
        } catch (error) {
          return message(error);
        }
      }
    });
    if (name === undefined) return;
    const { folders, name: file } = notePath(name, store.defaultExtension);
    let target: string;
    try {
      target = await store.createFile(await store.ensureFolder(folders, directory(store, entry)), file);
    } catch (error) {
      if (!(error instanceof ExistsError) || !(await fs.lstat(error.target).catch(() => undefined))?.isFile()) throw error;
      tree.refresh();
      if ((await vscode.window.showWarningMessage(`同名のメモ${error.message}`, '既存のメモを開く')) === '既存のメモを開く')
        await open(error.target);
      return;
    }
    tree.refresh();
    await open(target);
  });
  register('memo.createFolder', async (store, entry) => {
    const name = await vscode.window.showInputBox({ prompt: '新規フォルダ名', validateInput: validateName });
    if (name === undefined) return;
    await store.createFolder(directory(store, entry), name);
    tree.refresh();
  });
  register('memo.createDaily', async store => {
    const now = new Date(),
      format = config().get<string>('dateFormat', 'YYYY-MM-DD');
    const { folders, title } = setting('dateFormat', () => dailyPath(now, format));
    const base = setting('dailyFolder', () => folderSegments(config().get<string>('dailyFolder', '')));
    const folder = await store.ensureFolder([...base, ...folders]);
    const target = await store.createFile(
      folder,
      checkedName(title + store.defaultExtension),
      dailyContent(config().get<string>('dailyTemplate', ''), now, format, vscode.env.language),
      true
    );
    tree.refresh();
    await open(target);
  });
  register('memo.search', async store => {
    const entry = await choose(store);
    if (entry) await open(entry.path);
  });
  register('memo.searchText', async store => {
    type Item = vscode.QuickPickItem & { target?: string; range?: vscode.Range };
    const pick = vscode.window.createQuickPick<Item>();
    pick.placeholder = 'メモ本文を検索（大文字・小文字を区別しません）';
    pick.matchOnDescription = true;
    const limit = 200;
    let current = 0,
      debounce: ReturnType<typeof setTimeout> | undefined,
      files: Promise<Entry[]> | undefined;
    // 検索画面を開いている間にメモが増減したら、次の検索で一覧を取り直す
    const changes = filesChanged.event(() => (files = undefined));
    const search = async (query: string, id: number) => {
      pick.busy = true;
      try {
        // ファイル一覧は検索画面を開いている間だけ使い回し、入力のたびにフォルダを走査しない
        files ??= store.allFiles();
        files.catch(() => (files = undefined));
        // 1件多く探し、上限を超えたかどうかを判定する
        const matches = await store.search(query, limit + 1, () => id !== current, files);
        if (id !== current) return;
        const items: Item[] = matches.slice(0, limit).map(m => ({
          label: m.text.trim().slice(0, 200) || '(空行)',
          description: `${path.relative(store.root, m.entry.path)}:${m.line + 1}${m.count > 1 ? `（この行に${m.count}件）` : ''}`,
          alwaysShow: true,
          target: m.entry.path,
          range: new vscode.Range(m.line, m.column, m.line, m.column + m.length)
        }));
        if (matches.length > limit)
          items.push(
            { label: '', kind: vscode.QuickPickItemKind.Separator, alwaysShow: true },
            {
              label: `$(info) 一致が${limit}件を超えたため、先頭の${limit}件だけを表示しています。語を足して絞り込んでください`,
              alwaysShow: true
            }
          );
        if (!matches.length && query.trim()) items.push({ label: '一致するメモはありません', alwaysShow: true });
        pick.items = items;
      } catch (error) {
        report(error);
      } finally {
        if (id === current) pick.busy = false;
      }
    };
    const done = new Promise<Item | undefined>(resolve => {
      pick.onDidChangeValue(value => {
        const id = ++current;
        clearTimeout(debounce);
        debounce = setTimeout(() => void search(value, id), 200);
      });
      pick.onDidAccept(() => {
        resolve(pick.selectedItems[0]);
        pick.hide();
      });
      pick.onDidHide(() => {
        current++;
        clearTimeout(debounce);
        resolve(undefined);
        changes.dispose();
        pick.dispose();
      });
    });
    pick.show();
    const item = await done;
    if (item?.target) await open(item.target, item.range);
  });
  register('memo.rename', async (store, argument) => {
    const entry = await choose(store, selected(argument));
    if (!entry) return;
    let name = await vscode.window.showInputBox({ prompt: '新しい名前（拡張子を含む）', value: entry.name, validateInput: validateName });
    if (name === undefined || name === entry.name) return;
    const fixed = hiddenRename(name, entry.directory, store.defaultExtension);
    if (fixed) {
      const answer = await vscode.window.showWarningMessage(
        `「${name}」はメモ一覧に表示されない拡張子です。`,
        { modal: true, detail: `「${fixed}」に変更すると一覧に表示されます。` },
        `「${fixed}」に変更`,
        'このまま変更'
      );
      if (!answer) return;
      if (answer !== 'このまま変更') name = fixed;
      if (name === entry.name) return;
    }
    await store.assertInside(entry.path);
    const target = path.join(path.dirname(entry.path), checkedName(name));
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(entry.path), vscode.Uri.file(target), { overwrite: false });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('名前を変更できませんでした。同名ファイルなどを確認してください。');
    tree.refresh();
  });
  register('memo.delete', async (store, argument, all) => {
    const targets = argument ? picked(argument, all) : view.selection.length ? [...view.selection] : [await choose(store)];
    const entries = topLevel(targets.filter((e): e is Entry => !!e));
    if (!entries.length) return;
    const [first] = entries;
    const prompt =
      entries.length === 1
        ? `「${first.name}」${first.directory ? 'とその内容' : ''}をゴミ箱へ移動しますか？`
        : `${entries.length}件の項目${entries.some(e => e.directory) ? '（フォルダはその内容も）' : ''}をゴミ箱へ移動しますか？`;
    const detail = entries.length === 1 ? undefined : entries.map(e => path.relative(store.root, e.path)).join('\n');
    const answer = await vscode.window.showWarningMessage(prompt, { modal: true, detail }, 'ゴミ箱へ移動');
    if (answer !== 'ゴミ箱へ移動') return;
    for (const entry of entries) {
      await store.assertInside(entry.path);
      if (path.resolve(entry.path) === store.root) throw new Error('保存先ルートは削除できません。');
    }
    try {
      for (const entry of entries) {
        await vscode.workspace.fs.delete(vscode.Uri.file(entry.path), { recursive: entry.directory, useTrash: true });
        await updateBookmarks(list => removeBookmarks(list, [entry.path]));
      }
    } finally {
      tree.refresh();
    }
  });
  register('memo.bookmark', async (store, argument, all) => {
    const active = activeNote(store);
    const targets = argument ? picked(argument, all).map(e => e.path) : active ? [active] : view.selection.map(e => e.path);
    if (!targets.length) {
      const entry = await choose(store);
      if (entry) targets.push(entry.path);
    }
    for (const target of targets) await store.assertInside(target);
    await updateBookmarks(list => addBookmarks(list, targets));
  });
  register('memo.unbookmark', async (store, argument, all) => {
    const active = activeNote(store);
    // ビューの選択はフォーカスを外しても残るため、コマンドパレットからはエディタで開いているメモを優先する
    const targets = argument
      ? picked(argument, all).map(e => e.path)
      : active && bookmarks.has(active)
        ? [active]
        : bookmarkView.selection.map(b => b.path);
    // 解除だけはファイルの有無を問わない。見つからなくなったブックマークも外せるようにする
    await updateBookmarks(list => list.filter(b => !targets.some(t => path.resolve(t) === b)));
  });
  register('memo.showInTree', async (store, argument) => {
    const target = (argument ?? bookmarkView.selection[0])?.path;
    if (!target) return;
    const directory = !!(await fs.stat(target).catch(() => undefined))?.isDirectory();
    if (!directory && !(await store.visible(target))) throw new Error('このメモはツリーに表示されていません。');
    await vscode.commands.executeCommand('memoExplorer.files.focus');
    await view.reveal(tree.entry(target, directory), { select: true, focus: true, expand: directory });
  });
  register('memo.reveal', async (store, argument) => {
    const entry = selected(argument);
    const target = entry?.path ?? store.root;
    await store.assertInside(target);
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
  });
  context.subscriptions.push(
    tree,
    view,
    bookmarks,
    bookmarkView,
    output,
    filesChanged,
    vscode.commands.registerCommand('memo.refresh', () => {
      ready = configure();
      return ready;
    }),
    vscode.commands.registerCommand('memo.settings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-tools.memo-explorer')
    ),
    vscode.window.onDidChangeActiveTextEditor(editor => reveal(editor)),
    // 名前の変更・ドラッグ&ドロップ（どちらも WorkspaceEdit）や、VS Code のエクスプローラーでの操作に追従する
    vscode.workspace.onDidRenameFiles(event =>
      updateBookmarks(list => event.files.reduce((l, f) => renameBookmarks(l, f.oldUri.fsPath, f.newUri.fsPath), list))
    ),
    vscode.workspace.onDidDeleteFiles(event =>
      updateBookmarks(list =>
        removeBookmarks(
          list,
          event.files.map(f => f.fsPath)
        )
      )
    ),
    view.onDidChangeVisibility(() => reveal()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('memoExplorer.storagePath') || event.affectsConfiguration('memoExplorer.defaultExtension'))
        ready = configure();
    }),
    {
      dispose: () => {
        generation++;
        watcher?.dispose();
        clearTimeout(timer);
      }
    }
  );
  ready = configure();
  await ready;
  return { tree, view, dragAndDrop, bookmarks, bookmarkView };
}
