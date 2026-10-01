import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MemoStore,
  ExistsError,
  topLevel,
  storagePath,
  noteName,
  notePath,
  validateName,
  formatDate,
  dailyPath,
  dailyContent,
  inside,
  folderSegments,
  isNote,
  hiddenRename
} from '../src/core';

test('home expansion and absolute storage paths', () => {
  assert.equal(storagePath('~/Documents/memo'), path.join(os.homedir(), 'Documents/memo'));
  assert.equal(storagePath('~'), os.homedir());
  assert.throws(() => storagePath('relative/path'));
});
test('portable names and configured extension', () => {
  for (const bad of ['', ' ', '..', '../escape', 'a/b', 'a\\b', 'CON.txt', 'a:', 'trailing.', ' tail', 'x\0'])
    assert.ok(validateName(bad), bad);
  assert.equal(validateName('会議メモ 01.md'), undefined);
  assert.equal(noteName('会議', '.md'), '会議.md');
  assert.equal(noteName('memo', 'txt'), 'memo.txt');
  assert.equal(noteName('memo.txt', '.md'), 'memo.txt');
  assert.equal(noteName('MEMO.Markdown', '.md'), 'MEMO.Markdown');
  assert.equal(noteName('議事録 2026.09.29', '.md'), '議事録 2026.09.29.md');
  assert.equal(noteName('v1.2', '.md'), 'v1.2.md');
  assert.equal(noteName('data.json', '.md'), 'data.json.md');
  assert.equal(noteName('app.log', '.log'), 'app.log');
  assert.deepEqual(notePath('2026/議事録 09.29', '.md'), { folders: ['2026'], name: '議事録 09.29.md' });
  assert.throws(() => noteName('memo', '../md'));
  assert.equal(inside('/memo', '/memo-other'), false);
});
test('note extensions and renames that would hide a note', () => {
  for (const name of ['a.md', 'a.MD', 'a.markdown', 'a.txt']) assert.equal(isNote(name, '.md'), true, name);
  for (const name of ['a', 'a.json', 'v1.2']) assert.equal(isNote(name, '.md'), false, name);
  assert.equal(isNote('a.log', 'log'), true);
  assert.equal(hiddenRename('b.md', false, '.md'), undefined);
  assert.equal(hiddenRename('b', false, '.md'), 'b.md');
  assert.equal(hiddenRename('b.json', false, 'txt'), 'b.json.txt');
  assert.equal(hiddenRename('folder.v2', true, '.md'), undefined);
});
test('local calendar date, custom tokens and templates', () => {
  const date = new Date(2026, 8, 9, 23, 59);
  assert.equal(formatDate(date, 'YYYY-MM-DD'), '2026-09-09');
  assert.equal(formatDate(date, '[Daily]-YY-M-D'), 'Daily-26-9-9');
  assert.equal(dailyContent('# {{date}}\n{{isoDate}}\n{{other}}', date, 'YYYYMMDD'), '# 20260909\n2026-09-09\n{{other}}');
  assert.equal(
    dailyContent(
      '{{year}}/{{month}}/{{day}} {{time}} {{weekday}} {{title}} {{constructor}}',
      new Date(2026, 8, 28, 7, 5),
      'YYYY/MM/YYYY-MM-DD',
      'en'
    ),
    '2026/09/28 07:05 Mon 2026-09-28 {{constructor}}'
  );
  assert.equal(dailyContent('{{weekday}}', new Date(2026, 8, 28), 'YYYY-MM-DD', 'ja'), '月');
});
test('daily note path tokens split into folders', () => {
  const date = new Date(2026, 8, 9);
  assert.deepEqual(dailyPath(date, 'YYYY-MM-DD'), { folders: [], title: '2026-09-09' });
  assert.deepEqual(dailyPath(date, 'YYYY/MM/YYYY-MM-DD'), { folders: ['2026', '09'], title: '2026-09-09' });
  assert.deepEqual(dailyPath(date, '[Daily]\\YYYY/D'), { folders: ['Daily', '2026'], title: '9' });
  for (const bad of ['YYYY/', '', '[..]/DD', 'YYYY/[a:b]']) assert.throws(() => dailyPath(date, bad), bad);
});
test('note paths with subfolders', () => {
  assert.deepEqual(notePath('memo', '.md'), { folders: [], name: 'memo.md' });
  assert.deepEqual(notePath('ideas/sub/memo.txt', '.md'), { folders: ['ideas', 'sub'], name: 'memo.txt' });
  assert.deepEqual(notePath('/ideas\\memo', '.md'), { folders: ['ideas'], name: 'memo.md' });
  for (const bad of ['', 'ideas/', '../memo', 'a/../b', 'a/CON/b', '.hidden/memo']) assert.throws(() => notePath(bad, '.md'), bad);
});
test('nested storage, file filtering, exclusive writes and daily preservation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-core-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoStore(path.join(root, 'vault'));
  await store.initialize();
  const folder = await store.createFolder(store.root, 'カテゴリ');
  await store.createFile(folder, '日本語.md', 'nested');
  await store.createFile(store.root, 'plain.txt');
  await store.createFile(store.root, 'UPPER.MD');
  await store.createFile(store.root, 'picture.png');
  await fs.mkdir(path.join(store.root, '.obsidian'));
  await store.createFile(path.join(store.root, '.obsidian'), 'hidden.md');
  const daily = await store.createFile(store.root, '2026-09-29.md', 'original', true);
  await store.createFile(store.root, '2026-09-29.md', 'replacement', true);
  assert.equal(await fs.readFile(daily, 'utf8'), 'original');
  await assert.rejects(
    store.createFile(store.root, '2026-09-29.md', 'bad'),
    (error: unknown) => error instanceof ExistsError && error.target === daily
  );
  await assert.rejects(store.createFolder(store.root, 'カテゴリ'), ExistsError);
  await assert.rejects(store.createFile(store.root, '../outside.md'));
  const entries = await store.entries();
  assert.equal(entries[0].directory, true);
  assert.equal(entries.length, 4);
  assert.equal((await store.allFiles()).length, 4);
  await fs.symlink(root, path.join(store.root, 'escape'));
  await assert.rejects(store.createFile(path.join(store.root, 'escape'), 'bad.md'));
  assert.equal(
    (await store.entries()).some(e => e.name === 'escape'),
    false
  );
  await fs.symlink(daily, path.join(store.root, 'linked.md'));
  await assert.rejects(store.createFile(store.root, 'linked.md', '', true));
  const custom = new MemoStore(store.root, '.log');
  await custom.createFile(store.root, 'extra.log');
  assert.ok((await custom.entries()).some(e => e.name === 'extra.log'));
  assert.equal(store.listed(path.join(folder, '日本語.md')), true);
  for (const hidden of [
    store.root,
    path.join(store.root, 'picture.png'),
    path.join(store.root, '.obsidian', 'hidden.md'),
    path.join(root, 'outside.md')
  ])
    assert.equal(store.listed(hidden), false, hidden);
  assert.equal(await store.ensureFolder(['ideas', 'sub'], folder), path.join(folder, 'ideas', 'sub'));
});
test('full-text search across notes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoStore(path.join(root, 'vault'));
  await store.initialize();
  const nested = await store.createFile(await store.createFolder(store.root, 'sub'), 'nested.md', 'first\r\nTODO: 牛乳を買う\n');
  const top = await store.createFile(store.root, 'top.txt', 'todo later\nnothing');
  await store.createFile(store.root, 'image.png', 'todo');
  await fs.mkdir(path.join(store.root, '.obsidian'));
  await fs.writeFile(path.join(store.root, '.obsidian', 'hidden.md'), 'todo');
  const matches = await store.search('ToDo');
  assert.deepEqual(
    matches.map(m => [m.entry.path, m.line, m.column, m.text]).sort(),
    [
      [nested, 1, 0, 'TODO: 牛乳を買う'],
      [top, 0, 0, 'todo later']
    ].sort()
  );
  assert.deepEqual(
    (await store.search('牛乳')).map(m => m.column),
    [6]
  );
  assert.equal((await store.search('todo', 1)).length, 1);
  assert.deepEqual(
    (await store.search('ToDo')).map(m => m.length),
    [4, 4]
  );
  await store.createFile(store.root, 'unicode.md', 'xİstanbul と a.b(c)*');
  const [unicode] = await store.search('STANBUL');
  assert.deepEqual([unicode.column, unicode.length], [2, 7], 'position in the original line even if lowercasing changes length');
  assert.deepEqual(
    (await store.search('A.B(C)*')).map(m => [m.column, m.length]),
    [[12, 7]],
    'regex characters are literal'
  );
  assert.deepEqual(await store.search('a.b(d)'), []);
  assert.deepEqual(await store.search('  '), []);
  assert.deepEqual(await store.search('todo', 200, () => true), []);
});
test('search reads many files and respects the limit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-many-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoStore(path.join(root, 'vault'));
  await store.initialize();
  const folder = await store.createFolder(store.root, 'sub');
  for (let i = 0; i < 40; i++) await store.createFile(i % 2 ? folder : store.root, `note${i}.md`, `hit ${i}\nhit again`);
  assert.equal((await store.search('hit')).length, 80);
  assert.equal((await store.search('hit', 25)).length, 25);
  assert.equal(new Set((await store.search('hit')).map(m => m.entry.path)).size, 40);
});
test('move planning for drag and drop', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-move-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoStore(path.join(root, 'vault'));
  await store.initialize();
  const entry = (p: string, directory = false) => ({ path: p, name: path.basename(p), directory });
  const a = entry(await store.createFolder(store.root, 'a'), true);
  const b = entry(await store.createFolder(store.root, 'b'), true);
  const child = entry(await store.createFolder(a.path, 'child'), true);
  const inner = entry(await store.createFile(a.path, 'inner.md'));
  const top = entry(await store.createFile(store.root, 'top.md'));
  assert.deepEqual(await store.planMove([top, inner], b.path), [
    { from: top.path, to: path.join(b.path, 'top.md') },
    { from: inner.path, to: path.join(b.path, 'inner.md') }
  ]);
  assert.deepEqual(await store.planMove([a, inner, child], b.path), [{ from: a.path, to: path.join(b.path, 'a') }]);
  assert.deepEqual(await store.planMove([top], store.root), []);
  await assert.rejects(store.planMove([a], a.path));
  await assert.rejects(store.planMove([a], child.path));
  await store.createFile(b.path, 'top.md');
  await assert.rejects(store.planMove([top], b.path));
  await assert.rejects(store.planMove([top], root));
  await assert.rejects(store.planMove([entry(store.root, true)], b.path));
});
test('daily folder settings create nested folders inside storage', async t => {
  assert.deepEqual(folderSegments(''), []);
  assert.deepEqual(folderSegments('/日記//2026/'), ['日記', '2026']);
  assert.deepEqual(folderSegments('Daily\\Notes'), ['Daily', 'Notes']);
  for (const bad of ['..', 'Daily/../x', 'a/CON', 'a/b:']) assert.throws(() => folderSegments(bad), bad);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-daily-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoStore(path.join(root, 'vault'));
  await store.initialize();
  assert.equal(await store.ensureFolder([]), store.root);
  const folder = await store.ensureFolder(['日記', '2026']);
  assert.equal(folder, path.join(store.root, '日記', '2026'));
  assert.equal(await store.ensureFolder(['日記', '2026']), folder);
  await store.createFile(store.root, 'file.md');
  await assert.rejects(store.ensureFolder(['file.md']));
  await fs.symlink(root, path.join(store.root, 'escape'));
  await assert.rejects(store.ensureFolder(['escape', 'daily']));
  await assert.rejects(fs.stat(path.join(root, 'daily')));
});
test('top-level selection removes duplicates and nested entries', () => {
  const entry = (p: string, directory = false) => ({ path: path.join('/memo', p), name: path.basename(p), directory });
  const folder = entry('a', true);
  assert.deepEqual(topLevel([entry('a/x.md'), folder, entry('a/b', true), entry('top.md'), entry('top.md'), entry('ab.md')]), [
    folder,
    entry('top.md'),
    entry('ab.md')
  ]);
});
