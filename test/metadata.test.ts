import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  splitFrontmatter,
  existingKeys,
  tagName,
  normalizeMetadata,
  mergeFrontmatter,
  frontmatterBlock,
  truncate,
  createMetadata,
  defaultCategories,
  Metadata,
  skipReason,
  markdown,
  fileSkipReason,
  addMetadataToFile,
  noteMetadata,
  readNotes,
  groupNotes,
  extractJson
} from '../src/metadata';
import { MemoStore, maxSearchSize } from '../src/core';
import { FoundationModel, ContextSizeError, CancelledError, TimeoutError, GuardrailError, ModelRequest } from '../src/foundationModel';

const metadata: Metadata = {
  title: 'ブックマークの保存方式',
  tags: ['VS-Code', 'ブックマーク'],
  summary: '保存方式をJSONファイルに切り替えた。',
  category: '技術',
  keywords: ['globalState', 'キュー']
};

test('frontmatter is split from the body', () => {
  assert.deepEqual(splitFrontmatter('---\ntitle: a\n---\n本文'), { yaml: 'title: a', body: '本文', end: 17 });
  assert.deepEqual(splitFrontmatter('---\r\ntitle: a\r\n---\r\n本文'), { yaml: 'title: a', body: '本文', end: 20 });
  assert.deepEqual(splitFrontmatter('---\n---\n本文'), { yaml: '', body: '本文', end: 8 });
  assert.deepEqual(splitFrontmatter('---\ntitle: a\n---'), { yaml: 'title: a', body: '', end: 16 });
  // 閉じがない、または先頭にないものはフロントマターではない
  assert.deepEqual(splitFrontmatter('---\n区切り線だけ'), { body: '---\n区切り線だけ', end: 0 });
  assert.deepEqual(splitFrontmatter('本文\n---\na: 1\n---\n'), { body: '本文\n---\na: 1\n---\n', end: 0 });
});

test('existing keys need confirmation except tags', () => {
  assert.deepEqual(existingKeys(undefined), []);
  assert.deepEqual(existingKeys('title: a\ntags: [x]\nsummary: ""\ncategory:\nkeywords: []'), ['title']);
  assert.throws(() => existingKeys('title: [a'), /解釈できません/);
  assert.throws(() => existingKeys('- a\n- b'), /キーと値/);
});

test('tags follow Obsidian rules', () => {
  assert.equal(tagName('VS Code'), 'VS-Code');
  assert.equal(tagName('#Node.js'), 'Node-js');
  assert.equal(tagName(' 問題  解決 '), '問題-解決');
  assert.equal(tagName('project/memo'), 'project/memo');
  assert.equal(tagName('2026'), undefined);
  assert.equal(tagName('!!!'), undefined);
});

test('model output is validated and normalized', () => {
  const result = normalizeMetadata(
    {
      title: ' タイトル\n改行 ',
      tags: ['VS Code', 'vs-code', '2026', 'a', 'b', 'c', 'd', 'e', 'f'],
      summary: '要約。',
      category: '開発',
      keywords: ['x', 'X', '', 1]
    },
    defaultCategories
  );
  assert.deepEqual(result, {
    title: 'タイトル 改行',
    tags: ['VS-Code', 'a', 'b', 'c', 'd', 'e'],
    summary: '要約。',
    category: 'その他',
    keywords: ['x']
  });
  assert.equal(normalizeMetadata({ ...metadata, category: '未知' }, ['A', 'B']).category, 'B');
  assert.throws(() => normalizeMetadata({ ...metadata, summary: '' }, defaultCategories), /要約/);
  assert.throws(() => normalizeMetadata('text', defaultCategories), /解釈できません/);
});

test('metadata is merged without losing existing frontmatter', () => {
  assert.equal(
    mergeFrontmatter(undefined, metadata, false),
    'tags:\n  - VS-Code\n  - ブックマーク\ntitle: ブックマークの保存方式\nsummary: 保存方式をJSONファイルに切り替えた。\ncategory: 技術\nkeywords:\n  - globalState\n  - キュー\n'
  );
  // 既存のキー・コメント・順序は残し、タグは足す
  const merged = mergeFrontmatter('# メモ\naliases: [bm]\ntitle: 手書き\ntags:\n  - "#vs-code"\n  - 設計\n', metadata, false);
  assert.equal(
    merged,
    '# メモ\naliases: [bm]\ntitle: 手書き\ntags:\n  - "#vs-code"\n  - 設計\n  - ブックマーク\nsummary: 保存方式をJSONファイルに切り替えた。\ncategory: 技術\nkeywords:\n  - globalState\n  - キュー\n'
  );
  assert.match(mergeFrontmatter('title: 手書き', metadata, true), /^title: ブックマークの保存方式$/m);
  // 文字列のタグはリストにする
  assert.match(mergeFrontmatter('tags: 設計, vs-code', metadata, false), /^tags:\n {2}- 設計\n {2}- vs-code\n {2}- ブックマーク\n/);
  assert.equal(frontmatterBlock('a: 1\n', '\r\n'), '---\r\na: 1\r\n---\r\n');
  assert.equal(frontmatterBlock(''), '---\n---\n');
});

test('long bodies are truncated on character boundaries', () => {
  assert.deepEqual(truncate('abc', 3), { text: 'abc', truncated: false });
  assert.deepEqual(truncate('ab😀c', 3), { text: 'ab', truncated: true });
  assert.deepEqual(truncate('abcd', 3), { text: 'abc', truncated: true });
});

test('metadata generation retries with a shorter body when the context overflows', async () => {
  const requests: ModelRequest[] = [];
  const respond = (request: ModelRequest) => {
    requests.push(request);
    if (requests.length === 1) return Promise.reject(new ContextSizeError('too long'));
    return Promise.resolve(JSON.stringify(metadata));
  };
  assert.deepEqual(await createMetadata(respond, 'メモ', 'あ'.repeat(100), defaultCategories, 80), metadata);
  assert.deepEqual(
    requests.map(r => r.text.length),
    [80, 40]
  );
  assert.match(requests[0].prompt, /ファイル名「メモ」.*先頭の一部/);
  assert.deepEqual((requests[0].schema as { properties: { category: { enum: string[] } } }).properties.category.enum, defaultCategories);
  // 2回目も超えたら諦める
  await assert.rejects(
    createMetadata(() => Promise.reject(new ContextSizeError('too long')), 'メモ', 'あ', defaultCategories),
    ContextSizeError
  );
  await assert.rejects(createMetadata(respond, 'メモ', ' \n', defaultCategories), /本文が空/);
  await assert.rejects(
    createMetadata(() => Promise.resolve('not json'), 'メモ', 'a', defaultCategories),
    /解釈できません/
  );
});

test('fm is called with arguments that survive hyphenated text', { skip: process.platform === 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-fake-fm-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fake = async (name: string, script: string) => {
    const file = path.join(directory, name);
    await fs.writeFile(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return file;
  };
  const request = { schema: { type: 'object' }, instructions: '指示', text: '- 牛乳\n- 卵', prompt: 'プロンプト' };
  // 引数をそのまま返す。スキーマは一時ファイルで渡す
  const echo = new FoundationModel(
    await fake('echo', 'for a in "$@"; do printf "%s|" "$a"; done; case "$3" in --schema=*) cat "${3#--schema=}";; esac')
  );
  assert.match(
    await echo.respond(request),
    /^respond\|--no-stream\|--schema=[^|]+schema\.json\|--instructions=指示\|--text=- 牛乳\n- 卵\|プロンプト\|\{"type":"object"\}$/
  );
  // スキーマなし・ガードレールを緩める指定
  assert.equal(
    await echo.respond({ permissive: true, instructions: '指示', text: '本文', prompt: 'プロンプト' }),
    'respond|--no-stream|--guardrails=permissive-content-transformations|--instructions=指示|--text=本文|プロンプト|'
  );
  assert.equal(await echo.available(), true);
  const overflow = new FoundationModel(
    await fake('overflow', `echo "Error: The session's transcript exceeded the model's context size." >&2; exit 1`)
  );
  await assert.rejects(overflow.respond(request), ContextSizeError);
  assert.equal(await overflow.available(), false);
  await assert.rejects(
    new FoundationModel(await fake('guardrail', `echo "Error: The model's safety guardrails were triggered." >&2; exit 1`)).respond(
      request
    ),
    GuardrailError
  );
  await assert.rejects(
    new FoundationModel(await fake('fail', 'echo "Error: unknown" >&2; exit 1')).respond(request),
    /エラーが発生しました。unknown/
  );
  // 応答がなければ1回だけやり直す
  const count = path.join(directory, 'count');
  const slow = new FoundationModel(await fake('slow', `echo x >> "${count}"; sleep 5`), 1000);
  await assert.rejects(slow.respond(request), TimeoutError);
  assert.equal((await fs.readFile(count, 'utf8')).trim().split('\n').length, 2);
  const abort = new AbortController();
  const pending = slow.respond(request, abort.signal);
  abort.abort();
  await assert.rejects(pending, CancelledError);
  await assert.rejects(new FoundationModel(path.join(directory, 'missing')).respond(request), /見つかりません/);
});

test('bulk targets skip processed, empty and non-markdown notes', () => {
  assert.equal(skipReason('---\nsummary: 済み\n---\n本文'), 'done');
  assert.equal(skipReason('---\ntitle: 手書き\n---\n本文'), undefined);
  assert.equal(skipReason('\uFEFF---\nsummary: 済み\n---\n本文'), 'done');
  assert.equal(skipReason('---\ntags: [a]\n---\n \n'), 'empty');
  assert.throws(() => skipReason('---\ntitle: [a\n---\n本文'), /解釈できません/);
  assert.equal(markdown('a.md', '.md'), true);
  assert.equal(markdown('a.MARKDOWN', '.md'), true);
  assert.equal(markdown('a.txt', '.txt'), false);
  assert.equal(markdown('a.mdx', '.mdx'), true);
});

test('metadata is written to files without clobbering edits', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-metadata-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'memo.md');
  const generate = (body: string) => {
    assert.equal(body, '- 本文\r\n');
    return Promise.resolve(metadata);
  };
  // BOM・改行コード・本文はそのまま残す
  await fs.writeFile(file, '\uFEFF---\r\naliases: [a]\r\n---\r\n- 本文\r\n');
  assert.equal(await addMetadataToFile(file, generate, () => false), undefined);
  const written = await fs.readFile(file, 'utf8');
  assert.match(written, /^\uFEFF---\r\naliases: \[a\]\r\ntags:\r\n {2}- VS-Code\r\n/);
  assert.ok(
    written.endsWith(
      'summary: 保存方式をJSONファイルに切り替えた。\r\ncategory: 技術\r\nkeywords:\r\n  - globalState\r\n  - キュー\r\n---\r\n- 本文\r\n'
    )
  );
  assert.deepEqual(await fs.readdir(root), ['memo.md']);
  // 付与済みは生成しない
  assert.equal(await fileSkipReason(file), 'done');
  assert.equal(
    await addMetadataToFile(
      file,
      () => assert.fail('generated'),
      () => false
    ),
    'done'
  );

  const original = '本文\n';
  await fs.writeFile(file, original);
  assert.equal(
    await addMetadataToFile(
      file,
      () => assert.fail('generated'),
      () => true
    ),
    'busy'
  );
  // 生成中にエディタで編集された、またはファイルが変更された場合は書き込まない
  let dirty = false;
  const editing = () => ((dirty = true), Promise.resolve(metadata));
  assert.equal(await addMetadataToFile(file, editing, () => dirty), 'busy');
  const changing = async () => (await fs.appendFile(file, '追記\n'), metadata);
  assert.equal(await addMetadataToFile(file, changing, () => false), 'changed');
  assert.equal(await fs.readFile(file, 'utf8'), original + '追記\n');

  await fs.writeFile(file, Buffer.alloc(maxSearchSize + 1, 'a'));
  assert.equal(await fileSkipReason(file), 'large');
  assert.equal(
    await addMetadataToFile(
      file,
      () => assert.fail('generated'),
      () => false
    ),
    'large'
  );
  await fs.writeFile(file, '');
  assert.equal(await fileSkipReason(file), 'empty');
});

test('all files can be listed from a subfolder', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-subfolder-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'a', 'b'), { recursive: true });
  for (const file of ['top.md', 'a/one.md', 'a/b/two.md']) await fs.writeFile(path.join(root, file), '');
  const store = new MemoStore(root);
  assert.deepEqual(
    (await store.allFiles(path.join(root, 'a'))).map(e => path.relative(root, e.path)),
    ['a/one.md', 'a/b/two.md'].map(p => path.normalize(p))
  );
  await assert.rejects(store.allFiles(os.tmpdir()), /保存先フォルダの外/);
});

test('search metadata is read leniently from frontmatter', () => {
  assert.deepEqual(noteMetadata('---\ntitle: T\nsummary: S\ncategory: 技術\ntags:\n  - "#a"\n  - b\n  - A\n---\n本文'), {
    tags: ['a', 'b'],
    category: '技術',
    title: 'T',
    summary: 'S'
  });
  assert.deepEqual(noteMetadata('\uFEFF---\ntags: a, b c\ncategory: 1\n---\n').tags, ['a', 'b', 'c']);
  assert.equal(noteMetadata('---\ncategory: 1\n---\n').category, undefined);
  // 壊れたフロントマターやフロントマターなしは値なし
  assert.deepEqual(noteMetadata('---\ntags: [a\n---\n'), { tags: [] });
  assert.deepEqual(noteMetadata('本文 #tag'), { tags: [] });
});

test('notes are grouped by category and tag', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-tags-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'a.md': '---\ncategory: 技術\ntags: [react, Hooks]\n---\n',
    'b.md': '---\ncategory: 技術\ntags: [React]\n---\n',
    'c.md': '---\ncategory: 生活\ntags: [買い物]\n---\n',
    'd.md': '本文だけ'
  };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  await fs.writeFile(path.join(root, 'large.md'), Buffer.alloc(maxSearchSize + 1, 'a'));
  const notes = await readNotes(
    [...Object.keys(files), 'large.md', 'missing.md'].map(name => ({ path: path.join(root, name), name, directory: false }))
  );
  assert.deepEqual(
    notes.map(n => n.entry.name),
    ['a.md', 'b.md', 'c.md', 'd.md']
  );
  assert.deepEqual(
    groupNotes(notes).map(g => [g.kind, g.name, g.notes.map(n => n.entry.name).join()]),
    [
      ['category', '技術', 'a.md,b.md'],
      ['category', '生活', 'c.md'],
      ['tag', 'react', 'a.md,b.md'],
      ['tag', 'Hooks', 'a.md'],
      ['tag', '買い物', 'c.md']
    ]
  );
});

test('guardrail rejections are retried as permissive text generation', async () => {
  const requests: ModelRequest[] = [];
  const respond = (request: ModelRequest) => {
    requests.push(request);
    if (requests.length === 1) return Promise.reject(new GuardrailError('blocked'));
    return Promise.resolve('はい。\n```json\n' + JSON.stringify({ ...metadata, category: '読書' }) + '\n```');
  };
  assert.deepEqual(await createMetadata(respond, '小説', '本文', defaultCategories), { ...metadata, category: 'その他' });
  assert.ok(requests[0].schema && !requests[0].permissive);
  assert.ok(!requests[1].schema && requests[1].permissive);
  assert.match(
    requests[1].prompt,
    /^ファイル名「小説」.*\n.*例: \{.*"category":"技術".*技術・仕事・学習・生活・アイデア・その他 のうち1つだけ/s
  );
  // 緩めても止められたら諦める
  let calls = 0;
  await assert.rejects(
    createMetadata(() => (calls++, Promise.reject(new GuardrailError('blocked'))), '小説', '本文', defaultCategories),
    GuardrailError
  );
  assert.equal(calls, 2);
});

test('JSON is extracted from text output', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('結果です: {"a":{"b":2}} 以上'), { a: { b: 2 } });
  assert.throws(() => extractJson('出力できません'), /解釈できません/);
});
