import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MemoTree } from '../src/extension';
import { formatDate } from '../src/core';

async function waitFor(check: () => Promise<boolean>, description: string) {
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
  const api = await ext.activate() as { tree: MemoTree };
  assert.equal(api.tree.store?.root, path.join(root, 'notes'));
  assert.ok((await fs.stat(api.tree.store!.root)).isDirectory());
  const commands = await vscode.commands.getCommands();
  for (const id of ['createFile', 'createDaily', 'createFolder', 'refresh', 'search', 'rename', 'delete', 'reveal', 'settings']) assert.ok(commands.includes(`memo.${id}`));
  let refreshes = 0;
  const subscription = api.tree.onDidChangeTreeData(() => refreshes++);
  try {
    await vscode.commands.executeCommand('memo.createDaily');
    const daily = path.join(api.tree.store!.root, `${formatDate(new Date(), 'YYYY-MM-DD')}.md`);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, daily);
    assert.ok((await fs.readFile(daily, 'utf8')).startsWith('# '));
    await fs.writeFile(daily, 'Do not replace this');
    await vscode.commands.executeCommand('memo.createDaily');
    assert.equal(await fs.readFile(daily, 'utf8'), 'Do not replace this');
    const baseline = refreshes;
    const nested = path.join(api.tree.store!.root, 'external');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'external.txt'), 'external');
    await waitFor(async () => refreshes > baseline, 'external creation watcher');
    const folder = (await api.tree.getChildren()).find(e => e.name === 'external');
    assert.ok(folder?.directory);
    const children = await api.tree.getChildren(folder);
    assert.equal(children[0].name, 'external.txt');
    const item = api.tree.getTreeItem(children[0]);
    await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, children[0].path);
    await new Promise(resolve => setTimeout(resolve, 400));
    let before = refreshes;
    await fs.writeFile(children[0].path, 'changed outside');
    await waitFor(async () => refreshes > before, 'external change watcher');
    await new Promise(resolve => setTimeout(resolve, 400));
    before = refreshes;
    await fs.unlink(children[0].path);
    await waitFor(async () => refreshes > before, 'external delete watcher');
    assert.equal((await api.tree.getChildren(folder)).length, 0);
    const switched = path.join(root, 'other-notes');
    await vscode.workspace.getConfiguration('memoExplorer').update('storagePath', switched, vscode.ConfigurationTarget.Global);
    await waitFor(async () => api.tree.store?.root === switched, 'storage reconfiguration');
    assert.deepEqual(await api.tree.getChildren(), []);
    await new Promise(resolve => setTimeout(resolve, 500));
    before = refreshes;
    await fs.writeFile(path.join(switched, 'new.md'), 'new');
    await waitFor(async () => refreshes > before, 'new storage watcher');
    assert.equal((await api.tree.getChildren())[0].name, 'new.md');
    await new Promise(resolve => setTimeout(resolve, 400));
    before = refreshes;
    await fs.writeFile(path.join(root, 'notes', 'old.md'), 'old root');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(refreshes, before, 'old watcher disposed');
    console.log('PASS integration: activation, commands, daily preservation, hierarchy, editor opening, external create/change/delete, storage switch, watcher disposal');
  } finally { subscription.dispose(); }
}
