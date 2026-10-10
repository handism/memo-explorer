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
  message,
  addBookmarks,
  removeBookmarks,
  renameBookmarks
} from './core';
import { MemoTree, MemoDragAndDrop } from './memoTree';
import { BookmarkTree, BrokenBookmarksError } from './bookmarkTree';
import { searchText } from './searchText';
import { FoundationModel, CancelledError } from './foundationModel';
import { splitFrontmatter, existingKeys, createMetadata, mergeFrontmatter, frontmatterBlock, defaultCategories } from './metadata';

export { MemoTree, MemoDragAndDrop } from './memoTree';
export { BookmarkTree, BrokenBookmarksError, Bookmark } from './bookmarkTree';

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
  const dragAndDrop = new MemoDragAndDrop(tree, () => ready, report);
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
  // ブックマークの保存ファイルを読めないときは、ビュー上に表示し、壊れていれば退避して作り直せるようにする
  let bookmarkFailure: string | undefined;
  const recover = async (error: BrokenBookmarksError) => {
    const answer = await vscode.window.showErrorMessage(
      `Memo Explorer: ${error.message}`,
      { detail: '壊れたファイルは別名で残し、空のブックマークから始め直します。' },
      '退避して作り直す'
    );
    if (answer !== '退避して作り直す') return;
    const backup = await bookmarks.reset();
    void vscode.window.showInformationMessage(`壊れたブックマークのファイルを退避しました。${backup}`);
  };
  context.subscriptions.push(
    bookmarks.onDidChangeStatus(error => {
      const text = error === undefined ? undefined : message(error);
      if (text === bookmarkFailure) return;
      bookmarkFailure = text;
      bookmarkView.message = text && `ブックマークを読み込めません。${text}`;
      if (!text) return;
      output.appendLine(text);
      if (error instanceof BrokenBookmarksError) recover(error).catch(report);
    })
  );
  await bookmarks.load().catch(() => undefined);
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
  /** reveal の途中でツリーが読み直されると、エラーにならず選択もされないまま終わるため、読み直しと重ならなくなるまでやり直す */
  async function revealEntry(target: string, directory: boolean, options: { select: boolean; focus: boolean; expand?: boolean }) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let changed = false;
      const listener = tree.onDidChangeTreeData(() => (changed = true));
      try {
        await view.reveal(tree.entry(target, directory), options);
      } finally {
        listener.dispose();
      }
      if (!changed) return;
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
        if (tree.store === store && (await store.visible(target))) await revealEntry(target, false, { select: true, focus: false });
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
  /** 右クリックした項目が複数選択に含まれていれば選択全体を、含まれていなければその項目だけを対象にする */
  const picked = <T extends { path: string }>(argument: T, all?: T[]) => (all?.some(e => e.path === argument.path) ? all : [argument]);
  /** コマンドパレットから実行したときは、エディタで開いているメモを対象にする */
  const activeNote = (store: MemoStore) => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'file' && store.listed(uri.fsPath) ? uri.fsPath : undefined;
  };
  /**
   * コマンドパレットから実行したときの対象。ツリーの選択はフォーカスを外しても残り、
   * 意図しない項目を操作しかねないため、エディタで開いているメモを優先する
   */
  const fallback = (store: MemoStore): Entry[] => {
    const active = activeNote(store);
    return active ? [tree.entry(active, false)] : [...view.selection];
  };
  /** 引数がなければツリーの選択を使い、ファイルが選ばれていればそのフォルダに作る */
  const directory = (store: MemoStore, argument?: Entry) => {
    const entry = argument ?? view.selection[0];
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
    const found = await searchText(store, filesChanged.event, report);
    if (found) await open(found.target, found.range);
  });
  const model = new FoundationModel();
  // メニューの表示に使う。判定には数秒かかることがあるため、起動を待たせない
  void model.available().then(ok => vscode.commands.executeCommand('setContext', 'memoExplorer.metadataAvailable', ok));
  register('memo.generateMetadata', async (store, argument) => {
    const entry = await choose(store, argument ?? fallback(store)[0]);
    if (!entry) return;
    if (entry.directory) throw new Error('メモを選んでください。');
    if (!(await model.available()))
      throw new Error(
        'Apple Foundation Models を利用できません。Apple Intelligence 対応の macOS で、ターミナルの fm license で利用規約に同意してください。'
      );
    await store.assertInside(entry.path);
    const categories = setting('metadata.categories', () => {
      const value = config().get<unknown>('metadata.categories', defaultCategories);
      if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string' && !!v.trim()))
        throw new Error('空でない文字列の配列で指定してください。');
      return value.length ? value.map(v => v.trim()) : defaultCategories;
    });
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.path));
    await vscode.window.showTextDocument(document, { preview: false });
    const { yaml, body } = splitFrontmatter(document.getText());
    const existing = existingKeys(yaml);
    let overwrite = false;
    if (existing.length) {
      const answer = await vscode.window.showWarningMessage(
        `${existing.join('、')} は既にあります。`,
        { modal: true, detail: 'tags は既存のタグに足します。' },
        '上書きする',
        '空の項目だけ追加'
      );
      if (!answer) return;
      overwrite = answer === '上書きする';
    }
    const version = document.version;
    let metadata;
    try {
      metadata = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `「${entry.name}」のメタデータを生成中…`, cancellable: true },
        (_, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          return createMetadata(request => model.respond(request, abort.signal), path.parse(entry.name).name, body, categories);
        }
      );
    } catch (error) {
      if (error instanceof CancelledError) return;
      throw error;
    }
    // 生成中に編集されると位置がずれるため、反映せずにやり直してもらう
    if (document.isClosed || document.version !== version)
      throw new Error('生成中にメモが変更されたため反映しませんでした。もう一度実行してください。');
    const current = splitFrontmatter(document.getText());
    const block = frontmatterBlock(
      mergeFrontmatter(current.yaml, metadata, overwrite),
      document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(current.end)), block);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('メタデータを書き込めませんでした。');
    void vscode.window.showInformationMessage('メタデータを追加しました。内容を確認して保存してください。');
  });
  register('memo.rename', async (store, argument) => {
    const entry = await choose(store, argument ?? fallback(store)[0]);
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
    const targets = argument ? picked(argument, all) : fallback(store);
    if (!targets.length) {
      const entry = await choose(store);
      if (entry) targets.push(entry);
    }
    const entries = topLevel(targets);
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
    const targets = (argument ? picked(argument, all) : fallback(store)).map(e => e.path);
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
    await revealEntry(target, directory, { select: true, focus: true, expand: directory });
  });
  register('memo.reveal', async (store, argument) => {
    const target = (argument ?? fallback(store)[0])?.path ?? store.root;
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
    // 失敗するとブックマークが追従しないまま残るため、黙って捨てずに知らせる
    vscode.workspace.onDidRenameFiles(event =>
      updateBookmarks(list => event.files.reduce((l, f) => renameBookmarks(l, f.oldUri.fsPath, f.newUri.fsPath), list)).catch(
        (error: unknown) => report(new Error(`ブックマークを名前の変更に追従できませんでした。${message(error)}`, { cause: error }))
      )
    ),
    vscode.workspace.onDidDeleteFiles(event =>
      updateBookmarks(list =>
        removeBookmarks(
          list,
          event.files.map(f => f.fsPath)
        )
      ).catch((error: unknown) => report(new Error(`削除した項目のブックマークを外せませんでした。${message(error)}`, { cause: error })))
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
