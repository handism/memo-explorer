import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** macOS 26 以降に同梱される Apple Foundation Models の CLI */
export const defaultCommand = '/usr/bin/fm';

export interface ModelRequest {
  /** 構造化出力の JSON Schema。省略するとテキストで出力する */
  schema?: object;
  /**
   * ユーザーの文章の要約・分類のように、入力を変換する用途向けにガードレールを緩める。
   * 構造化出力には効かず、既定のガードレールが適用される
   */
  permissive?: boolean;
  instructions: string;
  /** プロンプトに添える本文 */
  text: string;
  prompt: string;
}
/** 入力がモデルの文脈長を超えた */
export class ContextSizeError extends Error {}
export class CancelledError extends Error {
  constructor() {
    super('キャンセルしました。');
  }
}
export class TimeoutError extends Error {}
/** 入力または出力が Apple の安全フィルタ（ガードレール）に止められた */
export class GuardrailError extends Error {}

function run(command: string, args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, signal, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (signal?.aborted) return reject(new CancelledError());
        // 色付けの制御文字を除き、CLI の Error: 行を優先して伝える
        const detail = (stderr || stdout).replace(/\x1b\[[0-9;]*m/g, '').trim(); // eslint-disable-line no-control-regex
        const line = /^Error: (.*)$/m.exec(detail)?.[1] ?? (detail.split('\n')[0] || error.message);
        if (error.killed)
          reject(new TimeoutError(`Apple Foundation Models が${timeout / 1000}秒以内に応答しませんでした。`, { cause: error }));
        else if (/context size/i.test(line)) reject(new ContextSizeError(line, { cause: error }));
        else if (/guardrail/i.test(line))
          reject(
            new GuardrailError('Apple Foundation Models の安全フィルタ（ガードレール）により生成できませんでした。', { cause: error })
          );
        else if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          reject(new Error('Apple Foundation Models（/usr/bin/fm）が見つかりません。', { cause: error }));
        else reject(new Error(`Apple Foundation Models でエラーが発生しました。${line}`, { cause: error }));
      }
    );
  });
}

/**
 * fm を1件ずつ呼び出す。オンデバイスのモデルは同時に動かしても速くならないため、要求を順に処理する。
 * まれに応答が返らないことがあるため、時間内に終わらなければ1回だけやり直す
 */
export class FoundationModel {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly command = defaultCommand,
    readonly timeout = 60_000
  ) {}
  /** モデルを使えるか。macOS 以外や Apple Intelligence がオフの環境では false */
  async available(): Promise<boolean> {
    if (process.platform !== 'darwin' && this.command === defaultCommand) return false;
    try {
      await run(this.command, ['available'], 10_000);
      return true;
    } catch {
      return false;
    }
  }
  respond(request: ModelRequest, signal?: AbortSignal): Promise<string> {
    const result = this.queue.then(() => this.attempt(request, signal));
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async attempt(request: ModelRequest, signal?: AbortSignal): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-fm-'));
    try {
      const schema = path.join(directory, 'schema.json');
      if (request.schema) await fs.writeFile(schema, JSON.stringify(request.schema));
      // 「--text 値」の形では、- で始まる本文（Markdownの箇条書きなど）がオプションとみなされるため = でつなぐ
      const args = [
        'respond',
        '--no-stream',
        ...(request.schema ? [`--schema=${schema}`] : []),
        ...(request.permissive ? ['--guardrails=permissive-content-transformations'] : []),
        `--instructions=${request.instructions}`,
        `--text=${request.text}`,
        request.prompt
      ];
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw new CancelledError();
        try {
          return await run(this.command, args, this.timeout, signal);
        } catch (error) {
          if (!(error instanceof TimeoutError) || attempt > 0) throw error;
        }
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
