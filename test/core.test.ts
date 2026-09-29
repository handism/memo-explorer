import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoStore, topLevel, storagePath, noteName, validateName, formatDate, dailyContent, inside, folderSegments } from '../src/core';

test('home expansion and absolute storage paths', () => {
  assert.equal(storagePath('~/Documents/memo'), path.join(os.homedir(), 'Documents/memo'));
  assert.equal(storagePath('~'), os.homedir());
  assert.throws(() => storagePath('relative/path'));
});
test('portable names and configured extension', () => {
  for (const bad of ['', ' ', '..', '../escape', 'a/b', 'a\\b', 'CON.txt', 'a:', 'trailing.', ' tail', 'x\0']) assert.ok(validateName(bad), bad);
  assert.equal(validateName('会議メモ 01.md'), undefined);
  assert.equal(noteName('会議', '.md'), '会議.md');
  assert.equal(noteName('memo', 'txt'), 'memo.txt');
  assert.equal(noteName('memo.txt', '.md'), 'memo.txt');
  assert.throws(() => noteName('memo', '../md'));
  assert.equal(inside('/memo', '/memo-other'), false);
});
test('local calendar date, custom tokens and templates', () => {
  const date = new Date(2026, 8, 9, 23, 59);
  assert.equal(formatDate(date, 'YYYY-MM-DD'), '2026-09-09');
  assert.equal(formatDate(date, '[Daily]-YY-M-D'), 'Daily-26-9-9');
  assert.equal(dailyContent('# {{date}}\n{{isoDate}}\n{{other}}', date, 'YYYYMMDD'), '# 20260909\n2026-09-09\n{{other}}');
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
  await assert.rejects(store.createFile(store.root, '2026-09-29.md', 'bad'));
  await assert.rejects(store.createFolder(store.root, 'カテゴリ'));
  await assert.rejects(store.createFile(store.root, '../outside.md'));
  const entries = await store.entries();
  assert.equal(entries[0].directory, true);
  assert.equal(entries.length, 4);
  assert.equal((await store.allFiles()).length, 4);
  await fs.symlink(root, path.join(store.root, 'escape'));
  await assert.rejects(store.createFile(path.join(store.root, 'escape'), 'bad.md'));
  assert.equal((await store.entries()).some(e => e.name === 'escape'), false);
  await fs.symlink(daily, path.join(store.root, 'linked.md'));
  await assert.rejects(store.createFile(store.root, 'linked.md', '', true));
  const custom = new MemoStore(store.root, '.log');
  await custom.createFile(store.root, 'extra.log');
  assert.ok((await custom.entries()).some(e => e.name === 'extra.log'));
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
  assert.deepEqual(topLevel([entry('a/x.md'), folder, entry('a/b', true), entry('top.md'), entry('top.md'), entry('ab.md')]), [folder, entry('top.md'), entry('ab.md')]);
});
