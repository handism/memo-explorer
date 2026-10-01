import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';

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
  text: string;
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
      try {
        await fs.lstat(to);
        throw new Error(`移動先に「${name}」が既に存在します。`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      moves.push({ from, to });
    }
    return moves;
  }
  async allFiles(): Promise<Entry[]> {
    // シンボリックリンクは list() で除外されるため、配下の確認はルートの1回で足りる
    await this.assertInside(this.root);
    const result: Entry[] = [],
      pending = [this.root];
    while (pending.length) {
      for (const entry of await this.list(pending.pop()!)) {
        if (entry.directory) pending.push(entry.path);
        else result.push(entry);
      }
    }
    return result;
  }
  async search(query: string, limit = 200, cancelled = () => false): Promise<Match[]> {
    const result: Match[] = [];
    if (!query.trim()) return result;
    // 正規表現で照合し、大文字・小文字の変換で文字数が変わっても元の行での位置と長さを返す
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    const read = async (entry: Entry): Promise<Match[]> => {
      try {
        if ((await fs.stat(entry.path)).size > 2 * 1024 * 1024) return [];
        const matches: Match[] = [];
        // VS Code は BOM を除いて開くため、除かないと1行目の列位置が1つずれる
        (await fs.readFile(entry.path, 'utf8'))
          .replace(/^\uFEFF/, '')
          .split(/\r?\n/)
          .forEach((text, line) => {
            const found = pattern.exec(text);
            if (found) matches.push({ entry, line, column: found.index, length: found[0].length, text });
          });
        return matches;
      } catch {
        return [];
      }
    };
    const files = await this.allFiles();
    for (let start = 0; start < files.length && result.length < limit && !cancelled(); start += 16) {
      for (const matches of await Promise.all(files.slice(start, start + 16).map(read))) result.push(...matches);
    }
    return cancelled() ? [] : result.slice(0, limit);
  }
}
