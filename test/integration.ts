import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MemoTree } from '../src/extension';
import { formatDate, Entry } from '../src/core';

async function waitFor(check: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}
export async function run(): Promise<void> {
  const root = process.env.MEMO_TEST_ROOT!;
  assert.ok(root, 'isolated test root required');
  const ext = vscode.extensions.getExtension('local-tools.memo-explorer');
  assert.ok(ext);
  const api = (await ext.activate()) as {
    tree: MemoTree;
    view: vscode.TreeView<Entry>;
    dragAndDrop: vscode.TreeDragAndDropController<Entry>;
  };
  assert.equal(api.tree.store?.root, path.join(root, 'notes'));
  assert.ok((await fs.stat(api.tree.store.root)).isDirectory());
  const commands = await vscode.commands.getCommands();
  for (const id of [
    'createFile',
    'createDaily',
    'createFolder',
    'refresh',
    'search',
    'searchText',
    'rename',
    'delete',
    'reveal',
    'settings'
  ])
    assert.ok(commands.includes(`memo.${id}`));
  const keybindings = (ext.packageJSON as { contributes: { keybindings: { command: string }[] } }).contributes.keybindings;
  for (const id of ['memo.createDaily', 'memo.createFile', 'memo.search', 'memo.searchText', 'memoExplorer.files.focus'])
    assert.ok(
      keybindings.some(k => k.command === id),
      id
    );
  assert.ok(commands.includes('memoExplorer.files.focus'));
  let refreshes = 0;
  const subscription = api.tree.onDidChangeTreeData(() => refreshes++);
  try {
    await vscode.commands.executeCommand('memo.createDaily');
    const daily = path.join(api.tree.store.root, `${formatDate(new Date(), 'YYYY-MM-DD')}.md`);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, daily);
    assert.ok((await fs.readFile(daily, 'utf8')).startsWith('# '));
    await fs.writeFile(daily, 'Do not replace this');
    await vscode.commands.executeCommand('memo.createDaily');
    assert.equal(await fs.readFile(daily, 'utf8'), 'Do not replace this');
    await vscode.workspace.getConfiguration('memoExplorer').update('dailyFolder', '日記/Daily', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('memo.createDaily');
    const nestedDaily = path.join(api.tree.store.root, '日記', 'Daily', `${formatDate(new Date(), 'YYYY-MM-DD')}.md`);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, nestedDaily);
    assert.ok((await fs.readFile(nestedDaily, 'utf8')).startsWith('# '));
    await vscode.workspace.getConfiguration('memoExplorer').update('dateFormat', 'YYYY/MM/YYYY-MM-DD', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('memo.createDaily');
    const now = new Date();
    const tokenDaily = path.join(
      api.tree.store.root,
      '日記',
      'Daily',
      formatDate(now, 'YYYY'),
      formatDate(now, 'MM'),
      `${formatDate(now, 'YYYY-MM-DD')}.md`
    );
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, tokenDaily);
    assert.ok((await fs.readFile(tokenDaily, 'utf8')).startsWith(`# ${formatDate(now, 'YYYY/MM/YYYY-MM-DD')}`));
    await vscode.workspace.getConfiguration('memoExplorer').update('dateFormat', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('memoExplorer').update('defaultExtension', 'txt', vscode.ConfigurationTarget.Global);
    await waitFor(() => api.tree.store?.defaultExtension === '.txt', 'extension reconfiguration');
    await vscode.commands.executeCommand('memo.createDaily');
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, nestedDaily.replace(/\.md$/, '.txt'));
    await vscode.workspace.getConfiguration('memoExplorer').update('defaultExtension', undefined, vscode.ConfigurationTarget.Global);
    await waitFor(() => api.tree.store?.defaultExtension === '.md', 'extension restored');
    await vscode.workspace.getConfiguration('memoExplorer').update('dailyFolder', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('memoExplorer.files.focus');
    await waitFor(() => api.view.visible, 'tree view visible');
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(nestedDaily));
    await waitFor(() => api.view.selection[0]?.path === nestedDaily, 'auto reveal of active editor');
    assert.equal(api.tree.getParent(api.view.selection[0])?.path, path.dirname(nestedDaily));
    const baseline = refreshes;
    const nested = path.join(api.tree.store.root, 'external');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'external.txt'), 'external');
    await waitFor(() => refreshes > baseline, 'external creation watcher');
    const folder = (await api.tree.getChildren()).find(e => e.name === 'external');
    assert.ok(folder?.directory);
    const children = await api.tree.getChildren(folder);
    assert.equal(children[0].name, 'external.txt');
    const item = api.tree.getTreeItem(children[0]);
    assert.equal(item.iconPath, undefined, 'file icon theme applies via resourceUri');
    await vscode.commands.executeCommand(item.command!.command, ...(item.command!.arguments! as unknown[]));
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, children[0].path);
    await new Promise(resolve => setTimeout(resolve, 400));
    let before = refreshes;
    await fs.writeFile(children[0].path, 'changed outside');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(refreshes, before, 'content changes do not refresh the tree');
    before = refreshes;
    await fs.unlink(children[0].path);
    await waitFor(() => refreshes > before, 'external delete watcher');
    assert.equal((await api.tree.getChildren(folder)).length, 0);
    await new Promise(resolve => setTimeout(resolve, 400));
    before = refreshes;
    await fs.mkdir(path.join(api.tree.store.root, '.obsidian'));
    await fs.writeFile(path.join(api.tree.store.root, '.obsidian', 'workspace.json'), '{}');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(refreshes, before, 'hidden folder changes do not refresh the tree');
    let refreshed: (Entry | undefined)[] = [];
    const partial = api.tree.onDidChangeTreeData(e => refreshed.push(e));
    try {
      await fs.writeFile(path.join(nested, 'partial.md'), 'partial');
      await waitFor(() => refreshed.length > 0, 'partial refresh watcher');
      assert.deepEqual(refreshed, [folder], 'only the changed folder is refreshed');
      refreshed = [];
    } finally {
      partial.dispose();
    }
    await fs.unlink(path.join(nested, 'partial.md'));
    const target = path.join(api.tree.store.root, 'target');
    await fs.mkdir(target);
    const first = path.join(api.tree.store.root, 'first.md'),
      second = path.join(nested, 'second.md');
    await fs.writeFile(first, 'first');
    await fs.writeFile(second, 'second');
    const entry = (p: string, directory = false) => ({ path: p, name: path.basename(p), directory });
    const drop = async (sources: ReturnType<typeof entry>[], destination?: ReturnType<typeof entry>) => {
      const data = new vscode.DataTransfer();
      await api.dragAndDrop.handleDrag!(sources, data, new vscode.CancellationTokenSource().token);
      await api.dragAndDrop.handleDrop!(destination, data, new vscode.CancellationTokenSource().token);
    };
    await drop([entry(first), entry(second)], entry(target, true));
    assert.equal(await fs.readFile(path.join(target, 'first.md'), 'utf8'), 'first');
    assert.equal(await fs.readFile(path.join(target, 'second.md'), 'utf8'), 'second');
    await assert.rejects(fs.access(first));
    await assert.rejects(fs.access(second));
    await drop([entry(target, true)], entry(path.join(target, 'first.md')));
    assert.ok((await fs.stat(target)).isDirectory(), 'folder not moved into itself');
    await drop([entry(path.join(target, 'first.md'))]);
    assert.equal(await fs.readFile(first, 'utf8'), 'first');
    await drop([entry(target, true)], entry(nested, true));
    assert.equal(await fs.readFile(path.join(nested, 'target', 'second.md'), 'utf8'), 'second');
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'dropped.md'), 'dropped');
    const external = new vscode.DataTransfer();
    external.set('text/uri-list', new vscode.DataTransferItem(`${vscode.Uri.file(path.join(outside, 'dropped.md')).toString()}\r\n`));
    await api.dragAndDrop.handleDrop!(entry(nested, true), external, new vscode.CancellationTokenSource().token);
    assert.equal(await fs.readFile(path.join(nested, 'dropped.md'), 'utf8'), 'dropped', 'external drop copies into the folder');
    assert.equal(await fs.readFile(path.join(outside, 'dropped.md'), 'utf8'), 'dropped', 'external source is kept');
    const switched = path.join(root, 'other-notes');
    await vscode.workspace.getConfiguration('memoExplorer').update('storagePath', switched, vscode.ConfigurationTarget.Global);
    await waitFor(() => api.tree.store?.root === switched, 'storage reconfiguration');
    assert.deepEqual(await api.tree.getChildren(), []);
    await new Promise(resolve => setTimeout(resolve, 500));
    before = refreshes;
    await fs.writeFile(path.join(switched, 'new.md'), 'new');
    await waitFor(() => refreshes > before, 'new storage watcher');
    assert.equal((await api.tree.getChildren())[0].name, 'new.md');
    await new Promise(resolve => setTimeout(resolve, 400));
    before = refreshes;
    await fs.writeFile(path.join(root, 'notes', 'old.md'), 'old root');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(refreshes, before, 'old watcher disposed');
    console.log(
      'PASS integration: activation, commands, keybindings, daily preservation, daily folder, daily date folders, daily extension, auto reveal, file icons, hierarchy, editor opening, drag and drop move, external create/delete, no refresh on change, storage switch, watcher disposal, hidden folder ignore, partial refresh, external drop copy'
    );
  } finally {
    subscription.dispose();
  }
}
