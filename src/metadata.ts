import { parseDocument, isMap, isScalar, isSeq, Document } from 'yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ContextSizeError, GuardrailError, ModelRequest } from './foundationModel';
import { maxSearchSize, Entry } from './core';

/** 自動付与するフロントマターのキー。この順で追加する */
export const metadataKeys = ['tags', 'summary'] as const;
export interface Metadata {
  tags: string[];
  summary: string;
}
/** モデルに渡す本文の上限（文字数）。日本語のMarkdownはおよそ2文字で1トークンになり、文脈長は約4,000トークン */
export const inputLimit = 4000;
const maxTags = 6;

export interface Frontmatter {
  /** --- の間のYAML。フロントマターがなければ undefined */
  yaml?: string;
  body: string;
  /** フロントマター（閉じの --- の行末まで）の長さ。なければ0 */
  end: number;
}
/** 先頭のYAMLフロントマターを本文から分ける。閉じの --- がないものはフロントマターとみなさない */
export function splitFrontmatter(text: string): Frontmatter {
  const match = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { body: text, end: 0 };
  return { yaml: match[1] ?? '', body: text.slice(match[0].length), end: match[0].length };
}

function parse(yaml: string | undefined): Document {
  const doc = parseDocument(yaml ?? '');
  if (doc.errors.length) throw new Error(`既存のフロントマターを解釈できません。${doc.errors[0].message}`);
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error('既存のフロントマターがキーと値の形式ではありません。');
  return doc;
}
function empty(value: unknown): boolean {
  if (isScalar(value)) value = value.value;
  if (isSeq(value)) return !value.items.length;
  return value === null || value === undefined || value === '';
}
/** 上書きの確認が要る、既に値のあるキー。tags は既存のタグに足すため含めない */
export function existingKeys(yaml: string | undefined): string[] {
  const doc = parse(yaml);
  return metadataKeys.filter(key => key !== 'tags' && !empty(doc.get(key, true)));
}

/** Obsidian のタグに使えない文字（空白や記号）を - に置き換える。数字だけのタグはタグとして扱われないため除く */
export function tagName(value: string): string | undefined {
  const tag = value
    .trim()
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}\p{M}_/-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
  return tag && !/^\p{N}+$/u.test(tag) ? tag : undefined;
}
function unique(values: (string | undefined)[], limit: number): string[] {
  const seen = new Set<string>(),
    result: string[] = [];
  for (const value of values) {
    const key = value?.toLowerCase();
    if (!value || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.slice(0, limit);
}
function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
/** モデルの出力を検査して整える */
export function normalizeMetadata(raw: unknown): Metadata {
  if (typeof raw !== 'object' || raw === null) throw new Error('モデルの出力を解釈できません。');
  const value = raw as Record<string, unknown>;
  const metadata: Metadata = {
    tags: unique(list(value.tags).map(tagName), maxTags),
    summary: text(value.summary)
  };
  if (!metadata.summary) throw new Error('モデルの出力に要約がありません。');
  return metadata;
}

/** フロントマターの tags をタグの配列として読む。文字列ならカンマ・空白で区切る。空の要素（- だけの行）は除く */
function readTags(value: unknown): string[] {
  return isSeq(value)
    ? value.items.filter(item => !empty(item)).map(item => String(isScalar(item) ? item.value : item))
    : isScalar(value) && !empty(value)
      ? String(value.value).split(/[,\s]+/)
      : [];
}
function stringify(doc: Document): string {
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}
/**
 * 既存のフロントマターに生成結果を足したYAMLを返す。既存のキーやコメント、順序は残す。
 * tags は既存のタグに足して [a, b] の形で書き、summary は値がないとき（overwrite なら常に）だけ書き込む
 */
export function mergeFrontmatter(yaml: string | undefined, metadata: Metadata, overwrite: boolean): string {
  const doc = parse(yaml);
  if (doc.contents === null) doc.contents = doc.createNode({});
  const current = doc.get('tags', true);
  const tags = readTags(current).map(t => t.replace(/^#+/, ''));
  const known = new Set(tags.map(t => t.toLowerCase()));
  if (isSeq(current)) {
    // 空の要素はフロースタイルにすると [, a] という解釈できないYAMLになるため除く
    current.items = current.items.filter(item => !empty(item));
    for (const tag of metadata.tags) if (!known.has(tag.toLowerCase())) current.add(doc.createNode(tag));
    current.flow = true;
  } else {
    const node = doc.createNode(unique([...tags, ...metadata.tags], Infinity));
    node.flow = true;
    doc.set('tags', node);
  }
  if (overwrite || empty(doc.get('summary', true))) doc.set('summary', metadata.summary);
  return stringify(doc);
}
/** フロントマター全体（--- を含む）。本文の前に置く */
export function frontmatterBlock(yaml: string, eol = '\n'): string {
  return `---\n${yaml.endsWith('\n') || !yaml ? yaml : yaml + '\n'}---\n`.replace(/\n/g, eol);
}

/** 本文を上限で切る。サロゲートペアの途中では切らない */
export function truncate(body: string, limit: number): { text: string; truncated: boolean } {
  if (body.length <= limit) return { text: body, truncated: false };
  const end = /[\uD800-\uDBFF]/.test(body[limit - 1]) ? limit - 1 : limit;
  return { text: body.slice(0, end), truncated: true };
}
export function metadataSchema(): object {
  return {
    title: 'MemoMetadata',
    type: 'object',
    properties: {
      tags: { type: 'array', items: { type: 'string' }, description: '検索用タグ（3〜6個、日本語の短い名詞）' },
      summary: { type: 'string', description: '1〜2文の日本語要約' }
    },
    required: [...metadataKeys],
    'x-order': [...metadataKeys],
    additionalProperties: false
  };
}
const instructions =
  'あなたはMarkdownメモを整理するアシスタントです。与えられたメモの内容から、検索しやすくするためのメタデータを日本語で作成してください。メモに書かれていない事実は加えないでください。';

/** 構造化出力を使わないときに、出力の形を例で示す */
function example(): string {
  const sample = {
    tags: ['React', 'フック', '副作用'],
    summary: 'useEffectの依存配列の書き方と、StrictModeで2回実行される理由をまとめた。'
  };
  return (
    `メタデータを次の例と同じ形のJSONだけで出力してください。\n例: ${JSON.stringify(sample)}\n` +
    'tags は3〜6個の短い名詞、summary は本文を言い換えた1〜2文の要約。'
  );
}
/** テキストで出力させたときの JSON を取り出す。```json のコードブロックや前後の文を除く */
export function extractJson(output: string): unknown {
  const text = /```(?:json)?\s*([\s\S]*?)```/.exec(output)?.[1] ?? output;
  const start = text.indexOf('{'),
    end = text.lastIndexOf('}');
  try {
    return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
  } catch (error) {
    throw new Error('モデルの出力を解釈できません。', { cause: error });
  }
}

/**
 * メモ本文からメタデータを生成する。文脈長を超えたら本文を半分にして1回だけやり直す。
 * ガードレールに止められたら、緩めたガードレールで1回だけやり直す。緩めたガードレールは構造化出力に効かないため、
 * 出力の形を例で示してテキストで出力させる
 */
export async function createMetadata(
  respond: (request: ModelRequest) => Promise<string>,
  name: string,
  body: string,
  limit = inputLimit
): Promise<Metadata> {
  if (!body.trim()) throw new Error('本文が空のため、メタデータを生成できません。');
  let shortened = false,
    structured = true;
  for (;;) {
    const { text, truncated } = truncate(body, limit);
    const prompt = `ファイル名「${name}」のメモのメタデータを生成してください。${truncated ? '本文は長いため先頭の一部だけを渡しています。' : ''}`;
    try {
      const output = await respond(
        structured
          ? { schema: metadataSchema(), instructions, text, prompt }
          : { permissive: true, instructions, text, prompt: `${prompt}\n${example()}` }
      );
      return normalizeMetadata(extractJson(output));
    } catch (error) {
      if (error instanceof ContextSizeError && !shortened) {
        shortened = true;
        limit = Math.floor(limit / 2);
      } else if (error instanceof GuardrailError && structured) structured = false;
      else throw error;
    }
  }
}

/** 一括付与で付与しなかった理由。done は summary が既にあるメモ */
export type Skip = 'done' | 'empty' | 'large' | 'busy' | 'changed';
/** 一括付与で行うこと。対象外ならその理由を返す。フロントマターを解釈できなければ例外 */
export function bulkTask(text: string): 'generate' | 'done' | 'empty' {
  const { yaml, body } = splitFrontmatter(text.replace(/^\uFEFF/, ''));
  if (existingKeys(yaml).includes('summary')) return 'done';
  return body.trim() ? 'generate' : 'empty';
}
/** 一括付与の対象にする拡張子。.txt はフロントマターを書く形式ではないため除く */
export function markdown(file: string, defaultExtension: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return extension === '.md' || extension === '.markdown' || (extension !== '.txt' && extension === defaultExtension.toLowerCase());
}
async function read(file: string): Promise<string | undefined> {
  const handle = await fs.open(file, 'r');
  try {
    return (await handle.stat()).size > maxSearchSize ? undefined : await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}
/** ファイルに一括付与で行うこと。対象外ならその理由を返す */
export async function fileBulkTask(file: string): Promise<'generate' | 'done' | 'empty' | 'large'> {
  const text = await read(file);
  return text === undefined ? 'large' : bulkTask(text);
}
/** フロントマターを差し替えた全文。BOM と改行コードは保つ。yaml が undefined ならフロントマターごと消す */
function replaceFrontmatter(text: string, yaml: string | undefined): string {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const { end } = splitFrontmatter(text.slice(bom.length));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return bom + (yaml === undefined ? '' : frontmatterBlock(yaml, eol)) + text.slice(bom.length + end);
}
/** 同じフォルダの隠しファイルに書いてから置き換え、途中で止まってもメモを壊さない */
async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(temporary, content, { mode: (await fs.stat(file)).mode });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
/**
 * ファイルにメタデータを付与して保存し、行ったことを返す。既存の値は上書きしない。
 * busy はエディタで未保存の変更があるか。生成の前後で確かめ、生成中にファイルが変わっていれば書き込まない
 */
export async function addMetadataToFile(
  file: string,
  generate: (body: string) => Promise<Metadata>,
  busy: () => boolean
): Promise<'generate' | Skip> {
  if (busy()) return 'busy';
  const before = await read(file);
  if (before === undefined) return 'large';
  const task = bulkTask(before);
  if (task !== 'generate') return task;
  const { yaml, body } = splitFrontmatter(before.replace(/^\uFEFF/, ''));
  const metadata = await generate(body);
  if (busy()) return 'busy';
  if ((await read(file)) !== before) return 'changed';
  await writeAtomic(file, replaceFrontmatter(before, mergeFrontmatter(yaml, metadata, false)));
  return task;
}
/** ファイルに消去するフロントマターがあるか。none はフロントマターのないメモ */
export async function fileClearTask(file: string): Promise<'clear' | 'none' | 'large'> {
  const text = await read(file);
  if (text === undefined) return 'large';
  return splitFrontmatter(text.replace(/^\uFEFF/, '')).yaml === undefined ? 'none' : 'clear';
}
/** 消去しなかった理由 */
export type ClearSkip = 'none' | 'large' | 'busy';
/** ファイルのフロントマターを --- ごと消して保存する。中身を解釈できなくても消す */
export async function clearMetadataFromFile(file: string, busy: () => boolean): Promise<'cleared' | ClearSkip> {
  if (busy()) return 'busy';
  const before = await read(file);
  if (before === undefined) return 'large';
  if (splitFrontmatter(before.replace(/^\uFEFF/, '')).yaml === undefined) return 'none';
  await writeAtomic(file, replaceFrontmatter(before, undefined));
  return 'cleared';
}

/** 検索に使うフロントマターの値 */
export interface NoteMetadata {
  tags: string[];
  title?: string;
  summary?: string;
}
/** フロントマターから検索用の値を読む。解釈できないフロントマターは値なしとして扱う */
export function noteMetadata(text: string): NoteMetadata {
  const doc = parseDocument(splitFrontmatter(text.replace(/^\uFEFF/, '')).yaml ?? '');
  if (doc.errors.length || !isMap(doc.contents)) return { tags: [] };
  const value = doc.get('tags', true);
  const tags = readTags(value);
  const string = (key: string) => {
    const item = doc.get(key);
    return typeof item === 'string' && item.trim() ? item.trim() : undefined;
  };
  return {
    tags: unique(
      tags.map(t => t.trim().replace(/^#+/, '')),
      Infinity
    ),
    title: string('title'),
    summary: string('summary')
  };
}
/** メモのフロントマターを読む。2MB超や読めないメモは除く */
export async function readNotes(files: Entry[]): Promise<{ entry: Entry; metadata: NoteMetadata }[]> {
  const result: { entry: Entry; metadata: NoteMetadata }[] = [];
  for (let start = 0; start < files.length; start += 16) {
    const batch = await Promise.all(
      files.slice(start, start + 16).map(async entry => {
        try {
          const text = await read(entry.path);
          return text === undefined ? undefined : { entry, metadata: noteMetadata(text) };
        } catch {
          return undefined;
        }
      })
    );
    for (const note of batch) if (note) result.push(note);
  }
  return result;
}

export interface Group<T> {
  name: string;
  notes: T[];
}
/** タグごとにメモをまとめる。大文字・小文字は区別せず、件数の多い順（同数なら名前順）に並べる */
export function groupNotes<T extends { metadata: NoteMetadata }>(notes: T[]): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  for (const note of notes)
    for (const name of note.metadata.tags) {
      const group = groups.get(name.toLowerCase()) ?? { name, notes: [] };
      group.notes.push(note);
      groups.set(name.toLowerCase(), group);
    }
  return [...groups.values()].sort((a, b) => b.notes.length - a.notes.length || a.name.localeCompare(b.name));
}
