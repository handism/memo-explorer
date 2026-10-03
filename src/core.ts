import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function storagePath(value: string): string {
  const expanded = value === '~' ? os.homedir() : /^~[/\\]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new Error('保存先には絶対パスまたは ~/ から始まるパスを指定してください。');
  return path.resolve(expanded);
}

export function validateName(value: string): string | undefined {
  if (!value || !value.trim()) return '名前を入力してください。';
  if (value.startsWith('.')) return 'ドットで始まる名前は一覧に表示されないため使用できません。';
  if (value !== value.trim() || /[. ]$/.test(value)) return '名前の前後の空白や末尾のドットは使用できません。';
  // eslint-disable-next-line no-control-regex -- 制御文字はファイル名に使えないため意図的に検査する
  if (value === '.' || value === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(value)) return 'パス区切りや使用できない文字が含まれています。';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) return 'OSの予約名は使用できません。';
  if (Buffer.byteLength(value) > 240) return '名前が長すぎます（240バイト以内）。';
}
export function checkedName(value: string): string {
  const error = validateName(value);
  if (error) throw new Error(error);
  return value;
}
export function extension(value: string): string {
  if (!/^\.?[a-z0-9]+$/i.test(value)) throw new Error('デフォルト拡張子は .md などの英数字で指定してください。');
  return value.startsWith('.') ? value : `.${value}`;
}
function noteExtensions(suffix: string): Set<string> {
  return new Set(['.md', '.markdown', '.txt', extension(suffix).toLowerCase()]);
}
export function isNote(name: string, suffix: string): boolean {
  return noteExtensions(suffix).has(path.extname(name).toLowerCase());
}
export function noteName(value: string, suffix: string): string {
  checkedName(value);
  return checkedName(isNote(value, suffix) ? value : value + extension(suffix));
}
export function hiddenRename(name: string, directory: boolean, suffix: string): string | undefined {
  return directory || isNote(name, suffix) ? undefined : name + extension(suffix);
}
export function notePath(value: string, suffix: string): { folders: string[]; name: string } {
  if (/[/\\]\s*$/.test(value)) throw new Error('ファイル名を入力してください。');
  const folders = folderSegments(value);
  return { folders, name: noteName(folders.pop() ?? '', suffix) };
}
export function formatDate(date: Date, format: string): string {
  const y = String(date.getFullYear()),
    m = String(date.getMonth() + 1),
    d = String(date.getDate());
  const tokens: Record<string, string> = { YYYY: y, YY: y.slice(-2), MM: m.padStart(2, '0'), M: m, DD: d.padStart(2, '0'), D: d };
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MM|DD|M|D/g, (token, literal: string | undefined) => literal ?? tokens[token]);
}
export function dailyPath(date: Date, format: string): { folders: string[]; title: string } {
  const formatted = formatDate(date, format);
  if (/[/\\]\s*$/.test(formatted)) throw new Error('日付書式の末尾にパス区切りは使用できません。');
  const folders = folderSegments(formatted);
  return { folders, title: checkedName(folders.pop() ?? '') };
}
function weekday(date: Date, locale?: string): string {
  try {
    return date.toLocaleDateString(locale, { weekday: 'short' });
  } catch {
    return date.toLocaleDateString('en', { weekday: 'short' });
  }
}
export function dailyContent(template: string, date: Date, format: string, locale?: string): string {
  const values: Record<string, string> = {
    date: formatDate(date, format),
    isoDate: formatDate(date, 'YYYY-MM-DD'),
    year: formatDate(date, 'YYYY'),
    month: formatDate(date, 'MM'),
    day: formatDate(date, 'DD'),
    time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
    weekday: weekday(date, locale),
    title: dailyPath(date, format).title
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (Object.hasOwn(values, key) ? values[key] : match));
}
export function folderSegments(value: string): string[] {
  return value
    .split(/[/\\]/)
    .filter(segment => segment !== '')
    .map(checkedName);
}
export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
export interface Entry {
  path: string;
  name: string;
  directory: boolean;
}
export interface Match {
  entry: Entry;
  line: number;
  column: number;
  length: number;
  /** 同じ行での一致数。位置と長さは最初の一致を指す */
  count: number;
  text: string;
}
export interface CopyPlan {
  /** 作成するフォルダ。親が先に並ぶ */
  folders: string[];
  files: { from: string; to: string }[];
  /** 取り込まない項目（隠しファイル・リンク・メモ以外の拡張子など）の数 */
  skipped: number;
}
export class ExistsError extends Error {
  constructor(
    readonly target: string,
    options?: ErrorOptions
  ) {
    super(`「${path.basename(target)}」は既に存在します。`, options);
  }
}
export function topLevel(entries: Entry[]): Entry[] {
  const unique = [...new Map(entries.map(e => [path.resolve(e.path), e])).values()];
  return unique.filter(e => !unique.some(o => o !== e && o.directory && inside(o.path, e.path)));
}
/** ブックマークを追加順のまま末尾に足す。既にあるものは位置を変えない */
export function addBookmarks(list: readonly string[], targets: readonly string[]): string[] {
  const result = [...list];
  for (const target of targets.map(t => path.resolve(t))) if (!result.includes(target)) result.push(target);
  return result;
}
/** 対象と、フォルダならその配下のブックマークを外す */
export function removeBookmarks(list: readonly string[], targets: readonly string[]): string[] {
  const removed = targets.map(t => path.resolve(t));
  return list.filter(b => !removed.some(t => inside(t, b)));
}
/** 名前の変更・移動に追従する。フォルダの場合は配下のブックマークも付け替える */
export function renameBookmarks(list: readonly string[], from: string, to: string): string[] {
  const source = path.resolve(from),
    destination = path.resolve(to);
  return [...new Set(list.map(b => (inside(source, b) ? path.join(destination, path.relative(source, b)) : b)))];
}
/**
 * ドラッグした項目を、ドロップ先の位置へまとめて移す。ドロップ先がなければ末尾へ。
 * 下へ動かすときはドロップ先の後ろ、上へ動かすときは前に入れる。移す項目同士の順は保つ
 */
export function moveBookmarks(list: readonly string[], sources: readonly string[], target?: string): string[] {
  const moved = sources.map(s => path.resolve(s));
  const moving = list.filter(b => moved.includes(b));
  if (!moving.length || (target !== undefined && moving.includes(target))) return [...list];
  const rest = list.filter(b => !moving.includes(b));
  let index = target === undefined ? -1 : rest.indexOf(target);
  if (index < 0) index = rest.length;
  else if (list.indexOf(moving[0]) < list.indexOf(target!)) index++;
  rest.splice(index, 0, ...moving);
  return rest;
}
/** 全文検索で読むファイルの上限サイズ */
export const maxSearchSize = 2 * 1024 * 1024;
export class MemoStore {
  /** 先頭のドットを補った拡張子。不正な値はここで弾き、一覧表示の時点まで持ち越さない */
  readonly defaultExtension: string;
  private readonly noteExtensions: Set<string>;
  constructor(
    readonly root: string,
    defaultExtension = '.md'
  ) {
    this.defaultExtension = extension(defaultExtension);
    this.noteExtensions = noteExtensions(this.defaultExtension);
  }
  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }
  async assertInside(target: string): Promise<void> {
    if (!inside(this.root, target)) throw new Error('保存先フォルダの外は操作できません。');
    const [realRoot, realTarget] = await Promise.all([fs.realpath(this.root), fs.realpath(target)]);
    if (!inside(realRoot, realTarget)) throw new Error('保存先の外を指すリンクは操作できません。');
  }
  private note(name: string): boolean {
    return this.noteExtensions.has(path.extname(name).toLowerCase());
  }
  listed(target: string): boolean {
    const relative = path.relative(this.root, target);
    return !!relative && inside(this.root, target) && !relative.split(path.sep).some(s => s.startsWith('.')) && this.note(target);
  }
  /** .obsidian などの隠しフォルダ配下か。一覧に現れないため、ファイル監視で無視してよい */
  ignored(target: string): boolean {
    return (
      inside(this.root, target) &&
      path
        .relative(this.root, target)
        .split(path.sep)
        .some(s => s.startsWith('.'))
    );
  }
  /** 一覧に表示されるメモか。list() はシンボリックリンクを除外するため、途中にリンクを含むパスも表示されない */
  async visible(target: string): Promise<boolean> {
    if (!this.listed(target)) return false;
    let current = this.root;
    for (const segment of path.relative(this.root, target).split(path.sep)) {
      current = path.join(current, segment);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  async entries(directory = this.root): Promise<Entry[]> {
    await this.assertInside(directory);
    return this.list(directory);
  }
  private async list(directory: string): Promise<Entry[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith('.') && !e.isSymbolicLink() && (e.isDirectory() || (e.isFile() && this.note(e.name))))
      .map(e => ({ path: path.join(directory, e.name), name: e.name, directory: e.isDirectory() }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  async createFile(directory: string, name: string, content = '', existing = false): Promise<string> {
    await this.assertInside(directory);
    const target = path.join(directory, checkedName(name));
    try {
      await fs.writeFile(target, content, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!existing) throw new ExistsError(target, { cause: error });
      await this.assertInside(target);
      if (!(await fs.lstat(target)).isFile()) throw new Error('同名のフォルダまたはリンクが存在します。', { cause: error });
    }
    return target;
  }
  async createFolder(directory: string, name: string): Promise<string> {
    await this.assertInside(directory);
    const target = path.join(directory, checkedName(name));
    try {
      await fs.mkdir(target);
    } catch (error) {
      throw (error as NodeJS.ErrnoException).code === 'EEXIST' ? new ExistsError(target, { cause: error }) : error;
    }
    return target;
  }
  async ensureFolder(segments: string[], base = this.root): Promise<string> {
    let current = base;
    for (const segment of segments) {
      await this.assertInside(current);
      current = path.join(current, checkedName(segment));
      try {
        await fs.mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    await this.assertInside(current);
    if (!(await fs.stat(current)).isDirectory()) throw new Error(`「${path.relative(this.root, current)}」はフォルダではありません。`);
    return current;
  }
  async planMove(sources: Entry[], directory: string): Promise<{ from: string; to: string }[]> {
    await this.assertInside(directory);
    const destination = path.resolve(directory);
    const moves: { from: string; to: string }[] = [],
      names = new Set<string>();
    for (const source of topLevel(sources)) {
      const from = path.resolve(source.path);
      await this.assertInside(from);
      if (from === path.resolve(this.root)) throw new Error('保存先ルートは移動できません。');
      if (source.directory && inside(from, destination)) throw new Error(`「${source.name}」をそれ自身またはその中へは移動できません。`);
      if (path.dirname(from) === destination) continue;
      const name = path.basename(from),
        key = name.toLowerCase();
      if (names.has(key)) throw new Error(`同名の「${name}」が複数選択されています。`);
      names.add(key);
      const to = path.join(destination, name);
      await absent(to, `移動先に「${name}」が既に存在します。`);
      moves.push({ from, to });
    }
    return moves;
  }
  /**
   * OSのファイルマネージャなど、保存先の外からドロップされた項目のコピー先を決める。
   * フォルダは一覧に表示されるもの（メモとサブフォルダ）だけを取り込み、.git・画像・リンクなどは skipped に数える
   */
  async planCopy(sources: string[], directory: string): Promise<CopyPlan> {
    await this.assertInside(directory);
    const destination = path.resolve(directory);
    const plan: CopyPlan = { folders: [], files: [], skipped: 0 },
      names = new Set<string>();
    const walk = async (from: string, to: string) => {
      plan.folders.push(to);
      for (const e of await fs.readdir(from, { withFileTypes: true })) {
        const child = { from: path.join(from, e.name), to: path.join(to, e.name) };
        if (e.name.startsWith('.') || e.isSymbolicLink() || validateName(e.name)) plan.skipped++;
        else if (e.isDirectory()) await walk(child.from, child.to);
        else if (e.isFile() && this.note(e.name)) plan.files.push(child);
        else plan.skipped++;
      }
    };
    for (const source of sources) {
      const from = path.resolve(source),
        name = checkedName(path.basename(from)),
        key = name.toLowerCase();
      const stat = await fs.lstat(from);
      if (stat.isSymbolicLink()) throw new Error(`「${name}」はリンクのため取り込めません。`);
      if (stat.isDirectory() ? inside(from, destination) : !stat.isFile()) throw new Error(`「${name}」は取り込めません。`);
      if (stat.isFile() && !this.note(name)) throw new Error(`「${name}」はメモとして扱えない拡張子のため取り込めません。`);
      if (names.has(key)) throw new Error(`同名の「${name}」が複数選択されています。`);
      names.add(key);
      const to = path.join(destination, name);
      await absent(to, `取り込み先に「${name}」が既に存在します。`);
      if (stat.isDirectory()) await walk(from, to);
      else plan.files.push({ from, to });
    }
    return plan;
  }
  async allFiles(): Promise<Entry[]> {
    // シンボリックリンクは list() で除外されるため、配下の確認はルートの1回で足りる
    await this.assertInside(this.root);
    const result: Entry[] = [],
      pending = [this.root];
    // ツリーと同じ順（フォルダごとに名前順）に並べる。後から取り出すため、サブフォルダは逆順に積む
    while (pending.length) {
      const entries = await this.list(pending.pop()!);
      result.push(...entries.filter(e => !e.directory));
      pending.push(
        ...entries
          .filter(e => e.directory)
          .map(e => e.path)
          .reverse()
      );
    }
    return result;
  }
  /**
   * files を渡すとフォルダの走査を省く。入力のたびに検索する場合は一覧を使い回す。
   * 大きすぎて読まなかったメモは skipped で知らせる
   */
  async search(
    query: string,
    limit = 200,
    cancelled = () => false,
    files?: Entry[] | Promise<Entry[]>,
    skipped?: (entry: Entry) => void
  ): Promise<Match[]> {
    const result: Match[] = [];
    // 前後の空白は無視する。空白だけのクエリは検索しない
    const trimmed = query.trim();
    if (!trimmed) return result;
    // 正規表現で照合し、大文字・小文字の変換で文字数が変わっても元の行での位置と長さを返す
    const pattern = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const read = async (entry: Entry): Promise<Match[]> => {
      let handle: fs.FileHandle | undefined;
      try {
        // 開いたハンドルでサイズを確かめてから読み、パスの解決を1回で済ませる
        handle = await fs.open(entry.path, 'r');
        if ((await handle.stat()).size > maxSearchSize) {
          skipped?.(entry);
          return [];
        }
        const matches: Match[] = [];
        // VS Code は BOM を除いて開くため、除かないと1行目の列位置が1つずれる
        (await handle.readFile('utf8'))
          .replace(/^\uFEFF/, '')
          .split(/\r?\n/)
          .forEach((text, line) => {
            const found = [...text.matchAll(pattern)];
            if (found.length) matches.push({ entry, line, column: found[0].index, length: found[0][0].length, count: found.length, text });
          });
        return matches;
      } catch {
        return [];
      } finally {
        await handle?.close();
      }
    };
    files = await (files ?? this.allFiles());
    for (let start = 0; start < files.length && result.length < limit && !cancelled(); start += 16) {
      for (const matches of await Promise.all(files.slice(start, start + 16).map(read))) result.push(...matches);
    }
    return cancelled() ? [] : result.slice(0, limit);
  }
}
async function absent(target: string, message: string): Promise<void> {
  try {
    await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(message);
}
