import { parseDocument, isMap, isScalar, isSeq, Document } from 'yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ContextSizeError, ModelRequest } from './foundationModel';
import { maxSearchSize } from './core';

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

/** メモ本文からメタデータを生成する。文脈長を超えたら本文を半分にして1回だけやり直す */
export async function createMetadata(
  respond: (request: ModelRequest) => Promise<string>,
  name: string,
  body: string,
  categories: readonly string[],
  limit = inputLimit
): Promise<Metadata> {
  if (!body.trim()) throw new Error('本文が空のため、メタデータを生成できません。');
  for (let attempt = 0; ; attempt++) {
    const { text, truncated } = truncate(body, limit);
    try {
      const output = await respond({
        schema: metadataSchema(categories),
        instructions,
        text,
        prompt: `ファイル名「${name}」のメモのメタデータを生成してください。${truncated ? '本文は長いため先頭の一部だけを渡しています。' : ''}`
      });
      let raw: unknown;
      try {
        raw = JSON.parse(output);
      } catch (error) {
        throw new Error('モデルの出力を解釈できません。', { cause: error });
      }
      return normalizeMetadata(raw, categories);
    } catch (error) {
      if (!(error instanceof ContextSizeError) || attempt > 0) throw error;
      limit = Math.floor(limit / 2);
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
