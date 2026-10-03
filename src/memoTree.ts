import * as vscode from 'vscode';
import * as path from 'node:path';
import { MemoStore, Entry, inside, message } from './core';

/** メモツリーからのドラッグ。ブックマークビューへのドロップでも受け取る */
export const memoMime = 'application/vnd.code.tree.memoexplorer.files';
const uriList = 'text/uri-list';

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

/** ツリー内のドラッグは移動、OSのファイルマネージャやエクスプローラーからのドロップはコピーとして取り込む */
export class MemoDragAndDrop implements vscode.TreeDragAndDropController<Entry> {
  readonly dragMimeTypes = [memoMime];
  readonly dropMimeTypes = [memoMime, uriList];
  constructor(
    private readonly tree: MemoTree,
    /** 保存先の読み込みを待つ。設定変更のたびに作り直されるため関数で受け取る */
    private readonly ready: () => Promise<void>,
    private readonly report: (error: unknown) => void
  ) {}
  handleDrag(sources: readonly Entry[], data: vscode.DataTransfer): void {
    data.set(memoMime, new vscode.DataTransferItem(sources));
  }
  async handleDrop(target: Entry | undefined, data: vscode.DataTransfer): Promise<void> {
    const sources = data.get(memoMime)?.value as Entry[] | undefined;
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
      await this.ready();
      const store = this.tree.store;
      if (!store) throw new Error('保存先の設定を確認してください。');
      const destination = !target ? store.root : target.directory ? target.path : path.dirname(target.path);
      if (sources?.length) await this.move(store, sources, destination);
      else await this.copy(store, external, destination);
    } catch (error) {
      this.report(error);
    }
  }
  private async move(store: MemoStore, sources: Entry[], destination: string): Promise<void> {
    const moves = await store.planMove(sources, destination);
    if (!moves.length) return;
    const edit = new vscode.WorkspaceEdit();
    for (const move of moves) edit.renameFile(vscode.Uri.file(move.from), vscode.Uri.file(move.to), { overwrite: false });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('移動できませんでした。同名ファイルなどを確認してください。');
    this.tree.refresh();
  }
  private async copy(store: MemoStore, sources: string[], destination: string): Promise<void> {
    const plan = await store.planCopy(sources, destination);
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
        { cause: error }
      );
    } finally {
      this.tree.refresh();
    }
    if (plan.skipped)
      void vscode.window.showInformationMessage(
        `メモ以外の項目（隠しファイル・リンク・対応していない拡張子など）${plan.skipped}件は取り込みませんでした。`
      );
  }
}
