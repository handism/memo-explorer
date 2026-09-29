import * as vscode from 'vscode';
import * as path from 'node:path';
import { MemoStore, Entry, topLevel, storagePath, noteName, validateName, checkedName, formatDate, dailyContent } from './core';

export class MemoTree implements vscode.TreeDataProvider<Entry>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Entry | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  store?: MemoStore;
  refresh(): void { this.changed.fire(undefined); }
  getTreeItem(entry: Entry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.name, entry.directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(entry.path);
    item.id = entry.path;
    item.contextValue = entry.directory ? 'memoFolder' : 'memoFile';
    item.iconPath = new vscode.ThemeIcon(entry.directory ? 'folder' : 'file');
    if (!entry.directory) item.command = { command: 'vscode.open', title: 'メモを開く', arguments: [item.resourceUri, { preview: false }] };
    return item;
  }
  async getChildren(entry?: Entry): Promise<Entry[]> {
    try { return this.store ? await this.store.entries(entry?.path) : []; }
    catch (error) { void vscode.window.showErrorMessage(`Memo Explorer: ${message(error)}`); return []; }
  }
  dispose(): void { this.changed.dispose(); }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function activate(context: vscode.ExtensionContext) {
  const tree = new MemoTree();
  const output = vscode.window.createOutputChannel('Memo Explorer');
  let watcher: vscode.FileSystemWatcher | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready: Promise<void>;
  const config = () => vscode.workspace.getConfiguration('memoExplorer');
  const report = (error: unknown) => {
    output.appendLine(message(error));
    void vscode.window.showErrorMessage(`Memo Explorer: ${message(error)}`);
  };
  const mime = 'application/vnd.code.tree.memoexplorer.files';
  const dragAndDrop: vscode.TreeDragAndDropController<Entry> = {
    dragMimeTypes: [mime],
    dropMimeTypes: [mime],
    handleDrag(sources, data) { data.set(mime, new vscode.DataTransferItem(sources)); },
    async handleDrop(target, data) {
      const sources = data.get(mime)?.value as Entry[] | undefined;
      if (!sources?.length) return;
      try {
        await ready;
        const store = tree.store;
        if (!store) throw new Error('保存先の設定を確認してください。');
        const moves = await store.planMove(sources, !target ? store.root : target.directory ? target.path : path.dirname(target.path));
        if (!moves.length) return;
        const edit = new vscode.WorkspaceEdit();
        for (const move of moves) edit.renameFile(vscode.Uri.file(move.from), vscode.Uri.file(move.to), { overwrite: false });
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('移動できませんでした。同名ファイルなどを確認してください。');
        tree.refresh();
      } catch (error) { report(error); }
    }
  };
  const view = vscode.window.createTreeView('memoExplorer.files', { treeDataProvider: tree, showCollapseAll: true, canSelectMany: true, dragAndDropController: dragAndDrop });
  async function configure(): Promise<void> {
    const current = ++generation;
    watcher?.dispose(); watcher = undefined;
    clearTimeout(timer);
    tree.store = undefined;
    tree.refresh();
    view.message = '保存先を読み込み中…';
    try {
      const store = new MemoStore(storagePath(config().get<string>('storagePath', '~/Documents/memo')), config().get<string>('defaultExtension', '.md'));
      await store.initialize();
      if (current !== generation) return;
      tree.store = store;
      view.description = store.root;
      view.message = undefined;
      watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(store.root), '**/*'));
      const refresh = () => { clearTimeout(timer); timer = setTimeout(() => tree.refresh(), 100); };
      watcher.onDidCreate(refresh); watcher.onDidChange(refresh); watcher.onDidDelete(refresh);
      tree.refresh();
    } catch (error) {
      if (current !== generation) return;
      view.message = `保存先を開けません。設定を確認して再読み込みしてください。${message(error)}`;
      report(error);
    }
  }
  const open = async (target: string) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(target)), { preview: false });
  const register = (id: string, handler: (store: MemoStore, entry?: Entry, entries?: Entry[]) => Promise<unknown>) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (entry?: Entry, entries?: Entry[]) => {
      try {
        await ready;
        const store = tree.store;
        if (!store) throw new Error('保存先の設定を確認してください。');
        return await handler(store, entry, entries);
      } catch (error) { report(error); }
    }));
  };
  const selected = (entry?: Entry) => entry ?? view.selection[0];
  const directory = (store: MemoStore, entry?: Entry) => entry?.directory ? entry.path : store.root;
  async function choose(store: MemoStore, entry?: Entry): Promise<Entry | undefined> {
    if (entry) return entry;
    const items = await store.allFiles();
    return (await vscode.window.showQuickPick(items.map(e => ({ label: e.name, description: path.relative(store.root, e.path), entry: e })), { placeHolder: 'メモファイル名を入力', matchOnDescription: true }))?.entry;
  }
  register('memo.createFile', async (store, entry) => {
    const name = await vscode.window.showInputBox({ prompt: '新規メモのファイル名', placeHolder: 'アイデア.md', validateInput: value => {
      try { noteName(value, store.defaultExtension); return undefined; } catch (error) { return message(error); }
    } });
    if (name === undefined) return;
    const target = await store.createFile(directory(store, entry), noteName(name, store.defaultExtension));
    tree.refresh(); await open(target);
  });
  register('memo.createFolder', async (store, entry) => {
    const name = await vscode.window.showInputBox({ prompt: '新規フォルダ名', validateInput: validateName });
    if (name === undefined) return;
    await store.createFolder(directory(store, entry), name); tree.refresh();
  });
  register('memo.createDaily', async store => {
    const now = new Date(), format = config().get<string>('dateFormat', 'YYYY-MM-DD');
    const name = checkedName(checkedName(formatDate(now, format)) + '.md');
    const target = await store.createFile(store.root, name, dailyContent(config().get<string>('dailyTemplate', ''), now, format), true);
    tree.refresh(); await open(target);
  });
  register('memo.search', async store => { const entry = await choose(store); if (entry) await open(entry.path); });
  register('memo.rename', async (store, argument) => {
    const entry = await choose(store, selected(argument)); if (!entry) return;
    const name = await vscode.window.showInputBox({ prompt: '新しい名前（拡張子を含む）', value: entry.name, validateInput: validateName });
    if (name === undefined || name === entry.name) return;
    await store.assertInside(entry.path);
    const target = path.join(path.dirname(entry.path), checkedName(name));
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(entry.path), vscode.Uri.file(target), { overwrite: false });
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('名前を変更できませんでした。同名ファイルなどを確認してください。');
    tree.refresh();
  });
  register('memo.delete', async (store, argument, all) => {
    const picked = argument ? (all?.some(e => e.path === argument.path) ? all : [argument]) : view.selection.length ? [...view.selection] : [await choose(store)];
    const entries = topLevel(picked.filter((e): e is Entry => !!e)); if (!entries.length) return;
    const [first] = entries;
    const prompt = entries.length === 1 ? `「${first.name}」${first.directory ? 'とその内容' : ''}をゴミ箱へ移動しますか？` : `${entries.length}件の項目${entries.some(e => e.directory) ? '（フォルダはその内容も）' : ''}をゴミ箱へ移動しますか？`;
    const detail = entries.length === 1 ? undefined : entries.map(e => path.relative(store.root, e.path)).join('\n');
    const answer = await vscode.window.showWarningMessage(prompt, { modal: true, detail }, 'ゴミ箱へ移動');
    if (answer !== 'ゴミ箱へ移動') return;
    for (const entry of entries) {
      await store.assertInside(entry.path);
      if (path.resolve(entry.path) === store.root) throw new Error('保存先ルートは削除できません。');
    }
    try { for (const entry of entries) await vscode.workspace.fs.delete(vscode.Uri.file(entry.path), { recursive: entry.directory, useTrash: true }); }
    finally { tree.refresh(); }
  });
  register('memo.reveal', async (store, argument) => {
    const entry = selected(argument);
    const target = entry?.path ?? store.root;
    await store.assertInside(target);
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
  });
  context.subscriptions.push(
    tree, view, output,
    vscode.commands.registerCommand('memo.refresh', () => { ready = configure(); return ready; }),
    vscode.commands.registerCommand('memo.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-tools.memo-explorer')),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('memoExplorer.storagePath') || event.affectsConfiguration('memoExplorer.defaultExtension')) ready = configure();
    }),
    { dispose: () => { generation++; watcher?.dispose(); clearTimeout(timer); } }
  );
  ready = configure();
  await ready;
  return { tree, view, dragAndDrop };
}
