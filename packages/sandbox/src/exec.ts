import { readdirSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough, type Readable, type Writable } from 'node:stream';

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/** Runs a process with an output cap and a SIGKILL timeout. */
export function runProcess(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runWithStdin(cmd, args, opts, (stdin) => {
    if (opts.input !== undefined) stdin.end(opts.input);
    else stdin.end();
  });
}

/**
 * Like {@link runProcess}, but stdin is fed from a stream (binary-safe, no buffering).
 * A stream error kills the child; the result then carries the child's exit status.
 */
export function runProcessFromStream(
  cmd: string,
  args: string[],
  input: Readable,
  opts: Omit<RunOptions, 'input'> = {},
): Promise<RunResult> {
  return runWithStdin(cmd, args, opts, (stdin, child) => {
    input.on('error', () => child.kill('SIGKILL'));
    // EPIPE when the child exits early is reported through its exit code, not as a crash.
    stdin.on('error', () => undefined);
    input.pipe(stdin);
  });
}

/**
 * Stream a directory as a tar archive (`tar -cf - -C dir .`). `done` resolves when tar exits 0 and
 * rejects with its stderr otherwise; `abort` kills it when the consumer gave up first.
 */
export function tarDirectory(dir: string): {
  stream: Readable;
  done: Promise<void>;
  abort: () => void;
} {
  /*
   * Top-level entries, not `.`: archiving `.` makes the extracting tar set the destination's own mode
   * and mtime, which GNU tar fails on for a dir the sandbox user does not own (`/workspace`, 1777 root).
   * `./` keeps names starting with `-` from reading as options.
   */
  const entries = readdirSync(dir).map((name) => `./${name}`);
  const child = spawn('tar', ['-cf', '-', '-C', dir, ...(entries.length > 0 ? entries : ['.'])], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => {
    if (stderr.length < 4_000) stderr += c.toString('utf8');
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim()}`)),
    );
  });
  // Callers await `done` only on the success path; keep a failed tar from becoming unhandled.
  done.catch(() => undefined);
  /*
   * Taken over at once: callers do other work before reading, and a small tree's tar may exit
   * meanwhile, losing its unread output. The PassThrough keeps it (with backpressure).
   */
  const stream = new PassThrough({ highWaterMark: 1024 * 1024 });
  child.stdout.pipe(stream);
  return { stream, done, abort: () => child.kill('SIGKILL') };
}

function runWithStdin(
  cmd: string,
  args: string[],
  opts: Omit<RunOptions, 'input'>,
  feed: (stdin: Writable, child: ChildProcess) => void,
): Promise<RunResult> {
  const maxBytes = opts.maxOutputBytes ?? 1_000_000;
  const startedAt = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const capture = (chunk: Buffer, which: 'out' | 'err') => {
      if (which === 'out') {
        if (stdoutBytes >= maxBytes) {
          stdoutTruncated = true;
          return;
        }
        const room = maxBytes - stdoutBytes;
        stdout += chunk.subarray(0, room).toString('utf8');
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxBytes) stdoutTruncated = true;
      } else {
        if (stderrBytes >= maxBytes) {
          stderrTruncated = true;
          return;
        }
        const room = maxBytes - stderrBytes;
        stderr += chunk.subarray(0, room).toString('utf8');
        stderrBytes += chunk.length;
        if (stderrBytes > maxBytes) stderrTruncated = true;
      }
    };

    child.stdout.on('data', (c: Buffer) => capture(c, 'out'));
    child.stderr.on('data', (c: Buffer) => capture(c, 'err'));

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    feed(child.stdin, child);
  });
}
