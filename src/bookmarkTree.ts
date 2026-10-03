import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Entry, inside, addBookmarks, moveBookmarks } from './core';
import { memoMime } from './memoTree';

export interface Bookmark {
  path: string;
  directory: boolean;
  /** 外部での名前変更・削除などで見つからない。勝手に外さず、利用者が解除できるよう残しておく */
  missing: boolean;
}
/** 保存ファイルの中身を解釈できない。reset() で退避して作り直せる */
export class BrokenBookmarksError extends Error {
  constructor(readonly file: string) {
    super(`ブックマークのファイルが壊れています。${file}`);
  }
}
export class BookmarkTree implements vscode.TreeDataProvider<Bookmark>, vscode.TreeDragAndDropController<Bookmark>, vscode.Disposable {
  /** v1.1 までの保存場所。ファイルがまだ無いときだけ引き継ぐ */
  private static readonly legacyKey = 'bookmarks';
  private static readonly mime = 'application/vnd.code.tree.memoexplorer.bookmarks';
  readonly dragMimeTypes = [BookmarkTree.mime];
  /** 並べ替えのほか、メモツリーからドロップされた項目を追加する */
  readonly dropMimeTypes = [BookmarkTree.mime, memoMime];
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly items = new vscode.EventEmitter<string[]>();
  /** 追加・解除された項目を通知する。メモツリー側の右クリックメニューを描き直すのに使う */
  readonly onDidChangeItems = this.items.event;
  private readonly status = new vscode.EventEmitter<unknown>();
  /** 保存ファイルを読めないとエラーを、読めると undefined を通知する */
  readonly onDidChangeStatus = this.status.event;
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
  /** 壊れた保存ファイルを別名で残し、空の一覧から始め直す。退避先のパスを返す */
  reset(): Promise<string> {
    return this.enqueue(async () => {
      const backup = `${this.file}.${Date.now()}.bak`;
      await fs.rename(this.file, backup);
      await this.write([]);
      this.status.fire(undefined);
      this.apply([], true);
      return backup;
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
    try {
      const list = await this.parse();
      this.status.fire(undefined);
      return list;
    } catch (error) {
      this.status.fire(error);
      throw error;
    }
  }
  private async parse(): Promise<string[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.legacy?.get<string[]>(BookmarkTree.legacyKey, []) ?? [];
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new BrokenBookmarksError(this.file);
    }
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new BrokenBookmarksError(this.file);
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
  /**
   * ブックマーク同士の並べ替えと、メモツリーからの追加。ドロップ先の位置へ入れ、空白部分へのドロップは末尾へ移す。
   * 追加した項目は末尾から上へ動かすことになるため、ドロップ先の前に入る
   */
  async handleDrop(target: Bookmark | undefined, data: vscode.DataTransfer): Promise<void> {
    const added = (data.get(memoMime)?.value as Entry[] | undefined)?.map(e => e.path) ?? [];
    const sources = added.length ? added : (data.get(BookmarkTree.mime)?.value as string[] | undefined);
    if (!sources?.length) return;
    await this.update(list => moveBookmarks(addBookmarks(list, added), sources, target?.path));
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
    // 読めなければ onDidChangeStatus で知らせ、最後に読めた一覧を表示し続ける
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
    this.status.dispose();
  }
}
