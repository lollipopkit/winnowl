import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HOST = join(__dirname, '../../../action/command-host.mjs');

function post(socketPath: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/run', method: 'POST' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('command host: bad requests get an answer and never stop the host', () => {
  let dir: string;
  let socket: string;
  let host: ChildProcess;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wnl-host-'));
    socket = join(dir, 'cmd.sock');
    host = spawn(process.execPath, [HOST, socket, dir, 'nobody-here'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => host.stdout!.once('data', () => resolve()));
  });

  afterAll(async () => {
    host.kill();
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['null', 'null', 400],
    ['an array', '[]', 400],
    ['a NUL byte in the command', JSON.stringify({ command: 'echo a\u0000b', timeoutSec: 10 }), 400],
    ['an unbounded timeout', JSON.stringify({ command: 'true', timeoutSec: 3_000_000 }), 400],
    ['a huge body', JSON.stringify({ command: 'x'.repeat(200_000), timeoutSec: 10 }), 413],
  ])('%s', async (_name, body, status) => {
    expect((await post(socket, body)).status).toBe(status);
    expect(host.exitCode).toBeNull();
  });
});
