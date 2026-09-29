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
export function noteName(value: string, suffix: string): string {
  checkedName(value);
  return checkedName(path.extname(value) ? value : value + extension(suffix));
}
export function formatDate(date: Date, format: string): string {
  const y = String(date.getFullYear()), m = String(date.getMonth() + 1), d = String(date.getDate());
  const tokens: Record<string, string> = { YYYY: y, YY: y.slice(-2), MM: m.padStart(2, '0'), M: m, DD: d.padStart(2, '0'), D: d };
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MM|DD|M|D/g, (token, literal: string | undefined) => literal ?? tokens[token]);
}
export function dailyContent(template: string, date: Date, format: string): string {
  return template.replace(/\{\{(date|isoDate)\}\}/g, (_, key: string) => formatDate(date, key === 'date' ? format : 'YYYY-MM-DD'));
}
export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
export interface Entry { path: string; name: string; directory: boolean }
export function topLevel(entries: Entry[]): Entry[] {
  const unique = [...new Map(entries.map(e => [path.resolve(e.path), e])).values()];
  return unique.filter(e => !unique.some(o => o !== e && o.directory && inside(o.path, e.path)));
}
export class MemoStore {
  constructor(readonly root: string, readonly defaultExtension = '.md') {}
  async initialize(): Promise<void> { await fs.mkdir(this.root, { recursive: true }); }
  async assertInside(target: string): Promise<void> {
    if (!inside(this.root, target)) throw new Error('保存先フォルダの外は操作できません。');
    const [realRoot, realTarget] = await Promise.all([fs.realpath(this.root), fs.realpath(target)]);
    if (!inside(realRoot, realTarget)) throw new Error('保存先の外を指すリンクは操作できません。');
  }
  async entries(directory = this.root): Promise<Entry[]> {
    await this.assertInside(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const suffixes = new Set(['.md', '.markdown', '.txt', extension(this.defaultExtension).toLowerCase()]);
    return entries.filter(e => !e.name.startsWith('.') && !e.isSymbolicLink() && (e.isDirectory() || (e.isFile() && suffixes.has(path.extname(e.name).toLowerCase()))))
      .map(e => ({ path: path.join(directory, e.name), name: e.name, directory: e.isDirectory() }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  async createFile(directory: string, name: string, content = '', existing = false): Promise<string> {
    await this.assertInside(directory);
    const target = path.join(directory, checkedName(name));
    try { await fs.writeFile(target, content, { flag: 'wx' }); }
    catch (error) {
      if (!existing || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await this.assertInside(target);
      if (!(await fs.lstat(target)).isFile()) throw new Error('同名のフォルダまたはリンクが存在します。');
    }
    return target;
  }
  async createFolder(directory: string, name: string): Promise<string> {
    await this.assertInside(directory);
    const target = path.join(directory, checkedName(name));
    await fs.mkdir(target);
    return target;
  }
  async planMove(sources: Entry[], directory: string): Promise<{ from: string; to: string }[]> {
    await this.assertInside(directory);
    const destination = path.resolve(directory);
    const moves: { from: string; to: string }[] = [], names = new Set<string>();
    for (const source of topLevel(sources)) {
      const from = path.resolve(source.path);
      await this.assertInside(from);
      if (from === path.resolve(this.root)) throw new Error('保存先ルートは移動できません。');
      if (source.directory && inside(from, destination)) throw new Error(`「${source.name}」をそれ自身またはその中へは移動できません。`);
      if (path.dirname(from) === destination) continue;
      const name = path.basename(from), key = name.toLowerCase();
      if (names.has(key)) throw new Error(`同名の「${name}」が複数選択されています。`);
      names.add(key);
      const to = path.join(destination, name);
      try { await fs.lstat(to); throw new Error(`移動先に「${name}」が既に存在します。`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      moves.push({ from, to });
    }
    return moves;
  }
  async allFiles(): Promise<Entry[]> {
    const result: Entry[] = [], pending = [this.root];
    while (pending.length) {
      for (const entry of await this.entries(pending.pop()!)) {
        if (entry.directory) pending.push(entry.path); else result.push(entry);
      }
    }
    return result;
  }
}
