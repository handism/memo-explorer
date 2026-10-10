import { parseDocument, isMap, isScalar, isSeq, Document } from 'yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ContextSizeError, GuardrailError, ModelRequest } from './foundationModel';
import { maxSearchSize, Entry } from './core';

/** 自動付与するフロントマターのキー。この順で追加する */
export const metadataKeys = ['title', 'tags', 'summary', 'category', 'keywords'] as const;
export interface Metadata {
  title: string;
  tags: string[];
  summary: string;
  category: string;
  keywords: string[];
}
export const defaultCategories = ['技術', '仕事', '学習', '生活', 'アイデア', 'その他'];
/** モデルに渡す本文の上限（文字数）。日本語のMarkdownはおよそ2文字で1トークンになり、文脈長は約4,000トークン */
export const inputLimit = 4000;
const maxTags = 6,
  maxKeywords = 8;

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
/** モデルの出力を検査して整える。カテゴリが候補になければ「その他」（なければ最後の候補）にする */
export function normalizeMetadata(raw: unknown, categories: readonly string[]): Metadata {
  if (typeof raw !== 'object' || raw === null) throw new Error('モデルの出力を解釈できません。');
  const value = raw as Record<string, unknown>;
  const category = text(value.category);
  const metadata: Metadata = {
    title: text(value.title),
    tags: unique(list(value.tags).map(tagName), maxTags),
    summary: text(value.summary),
    category: categories.includes(category) ? category : categories.includes('その他') ? 'その他' : categories[categories.length - 1],
    keywords: unique(list(value.keywords).map(text), maxKeywords)
  };
  if (!metadata.title || !metadata.summary) throw new Error('モデルの出力にタイトルまたは要約がありません。');
  return metadata;
}

/**
 * 既存のフロントマターに生成結果を足したYAMLを返す。既存のキーやコメント、順序は残す。
 * tags は既存のタグに足し、それ以外は値がないとき（overwrite なら常に）だけ書き込む
 */
export function mergeFrontmatter(yaml: string | undefined, metadata: Metadata, overwrite: boolean): string {
  const doc = parse(yaml);
  if (doc.contents === null) doc.contents = doc.createNode({});
  const current = doc.get('tags', true);
  const tags = isSeq(current)
    ? current.items.map(item => String(isScalar(item) ? item.value : item))
    : isScalar(current) && !empty(current)
      ? String(current.value).split(/[,\s]+/)
      : [];
  const merged = unique([...tags.map(t => t.replace(/^#+/, '')), ...metadata.tags], Infinity);
  if (isSeq(current)) {
    const known = new Set(tags.map(t => t.replace(/^#+/, '').toLowerCase()));
    for (const tag of metadata.tags) if (!known.has(tag.toLowerCase())) current.add(doc.createNode(tag));
  } else if (empty(current) || isScalar(current)) doc.set('tags', merged);
  for (const key of metadataKeys) {
    if (key === 'tags' || (!overwrite && !empty(doc.get(key, true)))) continue;
    doc.set(key, metadata[key]);
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
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
export function metadataSchema(categories: readonly string[]): object {
  return {
    title: 'MemoMetadata',
    type: 'object',
    properties: {
      title: { type: 'string', description: 'メモの内容を表す簡潔な日本語タイトル' },
      tags: { type: 'array', items: { type: 'string' }, description: '検索用タグ（3〜6個、日本語の短い名詞）' },
      summary: { type: 'string', description: '1〜2文の日本語要約' },
      category: { type: 'string', enum: [...categories], description: 'メモの分類' },
      keywords: { type: 'array', items: { type: 'string' }, description: '関連キーワード（5〜8個）' }
    },
    required: [...metadataKeys],
    'x-order': [...metadataKeys],
    additionalProperties: false
  };
}
const instructions =
  'あなたはMarkdownメモを整理するアシスタントです。与えられたメモの内容から、検索しやすくするためのメタデータを日本語で作成してください。メモに書かれていない事実は加えないでください。';

/** 構造化出力を使わないときに、出力の形を例で示す */
function example(categories: readonly string[]): string {
  const sample = {
    title: 'React useEffect の注意点',
    tags: ['React', 'フック', '副作用'],
    summary: 'useEffectの依存配列の書き方と、StrictModeで2回実行される理由をまとめた。',
    category: categories[0],
    keywords: ['useEffect', '依存配列', 'StrictMode', '再レンダリング', 'React 18']
  };
  return (
    `メタデータを次の例と同じ形のJSONだけで出力してください。\n例: ${JSON.stringify(sample)}\n` +
    `title は内容を表す短いタイトル、tags は3〜6個の短い名詞、summary は本文を言い換えた1〜2文の要約、keywords は5〜8個。category は ${categories.join('・')} のうち1つだけ。`
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
  categories: readonly string[],
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
          ? { schema: metadataSchema(categories), instructions, text, prompt }
          : { permissive: true, instructions, text, prompt: `${prompt}\n${example(categories)}` }
      );
      return normalizeMetadata(extractJson(output), categories);
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
/** 一括付与の対象か。対象外ならその理由を返す。フロントマターを解釈できなければ例外 */
export function skipReason(text: string): 'done' | 'empty' | undefined {
  const { yaml, body } = splitFrontmatter(text.replace(/^\uFEFF/, ''));
  if (existingKeys(yaml).includes('summary')) return 'done';
  if (!body.trim()) return 'empty';
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
/** ファイルが一括付与の対象か。対象外ならその理由を返す */
export async function fileSkipReason(file: string): Promise<'done' | 'empty' | 'large' | undefined> {
  const text = await read(file);
  return text === undefined ? 'large' : skipReason(text);
}
/**
 * ファイルにメタデータを付与して保存する。既存の値は上書きしない。
 * busy はエディタで未保存の変更があるか。生成の前後で確かめ、生成中にファイルが変わっていれば書き込まない。
 * 書き込みは同じフォルダの隠しファイルに書いてから置き換え、途中で止まってもメモを壊さない
 */
export async function addMetadataToFile(
  file: string,
  generate: (body: string) => Promise<Metadata>,
  busy: () => boolean
): Promise<Skip | undefined> {
  if (busy()) return 'busy';
  const before = await read(file);
  if (before === undefined) return 'large';
  const skip = skipReason(before);
  if (skip) return skip;
  const bom = before.startsWith('\uFEFF') ? '\uFEFF' : '';
  const { yaml, body, end } = splitFrontmatter(before.slice(bom.length));
  const metadata = await generate(body);
  if (busy()) return 'busy';
  if ((await read(file)) !== before) return 'changed';
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const content = bom + frontmatterBlock(mergeFrontmatter(yaml, metadata, false), eol) + before.slice(bom.length + end);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(temporary, content, { mode: (await fs.stat(file)).mode });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

/** 検索に使うフロントマターの値 */
export interface NoteMetadata {
  tags: string[];
  category?: string;
  title?: string;
  summary?: string;
}
/** フロントマターから検索用の値を読む。解釈できないフロントマターは値なしとして扱う */
export function noteMetadata(text: string): NoteMetadata {
  const doc = parseDocument(splitFrontmatter(text.replace(/^\uFEFF/, '')).yaml ?? '');
  if (doc.errors.length || !isMap(doc.contents)) return { tags: [] };
  const value = doc.get('tags', true);
  const tags = isSeq(value)
    ? value.items.map(item => String(isScalar(item) ? item.value : item))
    : isScalar(value) && !empty(value)
      ? String(value.value).split(/[,\s]+/)
      : [];
  const string = (key: string) => {
    const item = doc.get(key);
    return typeof item === 'string' && item.trim() ? item.trim() : undefined;
  };
  return {
    tags: unique(
      tags.map(t => t.trim().replace(/^#+/, '')),
      Infinity
    ),
    category: string('category'),
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
  kind: 'category' | 'tag';
  name: string;
  notes: T[];
}
/** カテゴリ・タグごとにメモをまとめる。大文字・小文字は区別せず、件数の多い順（同数なら名前順）に並べる */
export function groupNotes<T extends { metadata: NoteMetadata }>(notes: T[]): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  const add = (kind: Group<T>['kind'], name: string, note: T) => {
    const key = `${kind}:${name.toLowerCase()}`;
    const group = groups.get(key) ?? { kind, name, notes: [] };
    group.notes.push(note);
    groups.set(key, group);
  };
  for (const note of notes) {
    if (note.metadata.category) add('category', note.metadata.category, note);
    for (const tag of note.metadata.tags) add('tag', tag, note);
  }
  return [...groups.values()].sort(
    (a, b) => Number(a.kind === 'tag') - Number(b.kind === 'tag') || b.notes.length - a.notes.length || a.name.localeCompare(b.name)
  );
}
