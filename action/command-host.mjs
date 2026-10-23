// Runs review commands for the winnowl executor container, on the Actions runner host.
// usage: node command-host.mjs <socket> <workdir> <user>
// Commands run as <user> (no sudo, no docker, cannot read the runner user's processes) with a scrubbed
// environment in <workdir>; whatever they leave running is killed afterwards.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { commandEnv } from './command-env.mjs';

const [socket, workdir, user] = process.argv.slice(2);
if (!socket || !workdir || !user) {
  console.error('usage: command-host.mjs <socket> <workdir> <user>');
  process.exit(2);
}

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 96 * 1024;

/** Keeps the first and last bytes of a stream. */
function capture() {
  let head = Buffer.alloc(0);
  let tail = [];
  let tailLen = 0;
  let dropped = 0;
  return {
    push(chunk) {
      if (head.length < HEAD_BYTES) {
        const take = Math.min(HEAD_BYTES - head.length, chunk.length);
        head = Buffer.concat([head, chunk.subarray(0, take)]);
        chunk = chunk.subarray(take);
      }
      if (chunk.length === 0) return;
      tail.push(chunk);
      tailLen += chunk.length;
      while (tailLen - tail[0].length >= TAIL_BYTES) {
        dropped += tail[0].length;
        tailLen -= tail[0].length;
        tail.shift();
      }
    },
    text() {
      const t = Buffer.concat(tail).toString('utf8');
      return head.toString('utf8') + (dropped > 0 ? `\n…[${dropped} bytes omitted]…\n` : '') + t;
    },
  };
}

const killLeftovers = () => spawnSync('sudo', ['-n', 'pkill', '-KILL', '-u', user], { stdio: 'ignore' });

function runOne(command, timeoutSec) {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = Object.entries(commandEnv(process.env, user)).map(([k, v]) => `${k}=${v}`);
    const child = spawn(
      'sudo',
      ['-n', '-u', user, '--', '/usr/bin/env', '-i', ...env, 'timeout', '--kill-after=10', String(timeoutSec), 'bash', '-c', command],
      { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const out = capture();
    const err = capture();
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    // Backstop for a command that ignores timeout's signals.
    const guard = setTimeout(() => killLeftovers(), (timeoutSec + 30) * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      killLeftovers();
      resolve({
        exitCode: code ?? 128,
        stdout: out.text(),
        stderr: err.text(),
        // timeout(1) exits 124 on expiry, 137 after --kill-after.
        timedOut: code === 124 || code === 137 || signal !== null,
        durationMs: Date.now() - started,
      });
    });
  });
}

let busy = false;
const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/run') {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end('invalid json');
      return;
    }
    if (typeof body.command !== 'string' || !Number.isInteger(body.timeoutSec) || body.timeoutSec < 1) {
      res.writeHead(400).end('command and timeoutSec are required');
      return;
    }
    // The executor runs one command at a time; a second one would share the work tree.
    if (busy) {
      res.writeHead(409).end('another command is running');
      return;
    }
    busy = true;
    try {
      const result = await runOne(body.command, body.timeoutSec);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } finally {
      busy = false;
    }
  });
});

server.listen(socket, () => console.log(`winnowl command host ready (commands run as ${user} in ${workdir})`));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    killLeftovers();
    server.close();
    process.exit(0);
  });
}
