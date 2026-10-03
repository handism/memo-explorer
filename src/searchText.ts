import * as vscode from 'vscode';
import * as path from 'node:path';
import { MemoStore, Entry, maxSearchSize } from './core';

type Item = vscode.QuickPickItem & { target?: string; range?: vscode.Range };
const limit = 200;

/**
 * メモ本文の全文検索。入力のたびに検索し、選んだ一致行を返す。
 * filesChanged は保存先でファイルが作成・削除されたときに発火し、使い回しているファイル一覧を捨てる合図にする
 */
export async function searchText(
  store: MemoStore,
  filesChanged: vscode.Event<void>,
  report: (error: unknown) => void
): Promise<{ target: string; range: vscode.Range } | undefined> {
  const pick = vscode.window.createQuickPick<Item>();
  pick.placeholder = 'メモ本文を検索（大文字・小文字を区別しません）';
  pick.matchOnDescription = true;
  let current = 0,
    debounce: ReturnType<typeof setTimeout> | undefined,
    files: Promise<Entry[]> | undefined;
  // 検索画面を開いている間にメモが増減したら、次の検索で一覧を取り直す
  const changes = filesChanged(() => (files = undefined));
  const search = async (query: string, id: number) => {
    pick.busy = true;
    try {
      // ファイル一覧は検索画面を開いている間だけ使い回し、入力のたびにフォルダを走査しない
      files ??= store.allFiles();
      files.catch(() => (files = undefined));
      const skipped: Entry[] = [];
      // 1件多く探し、上限を超えたかどうかを判定する
      const matches = await store.search(
        query,
        limit + 1,
        () => id !== current,
        files,
        entry => skipped.push(entry)
      );
      if (id !== current) return;
      const items: Item[] = matches.slice(0, limit).map(m => ({
        label: m.text.trim().slice(0, 200) || '(空行)',
        description: `${path.relative(store.root, m.entry.path)}:${m.line + 1}${m.count > 1 ? `（この行に${m.count}件）` : ''}`,
        alwaysShow: true,
        target: m.entry.path,
        range: new vscode.Range(m.line, m.column, m.line, m.column + m.length)
      }));
      const notes: Item[] = [];
      if (matches.length > limit)
        notes.push({
          label: `$(info) 一致が${limit}件を超えたため、先頭の${limit}件だけを表示しています。語を足して絞り込んでください`,
          alwaysShow: true
        });
      if (skipped.length)
        notes.push({
          label: `$(warning) ${maxSearchSize / 1024 / 1024}MBを超えるため検索しなかったメモが${skipped.length}件あります`,
          description: skipped.map(e => path.relative(store.root, e.path)).join(', '),
          alwaysShow: true
        });
      if (!matches.length && query.trim()) items.push({ label: '一致するメモはありません', alwaysShow: true });
      if (items.length && notes.length) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, alwaysShow: true });
      pick.items = [...items, ...notes];
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
  return item?.target && item.range ? { target: item.target, range: item.range } : undefined;
}
