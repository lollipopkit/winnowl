// Runs review commands for the winnowl executor container, on the Actions runner host.
// usage: node command-host.mjs <socket> <workdir> <user>
// Commands run as <user> (no sudo, no docker, cannot read the runner user's processes) with a scrubbed
// environment in <workdir>; whatever they leave running is killed afterwards.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { commandEnv } from './command-env.mjs';

const [socket, workdir, user] = process.argv.slice(2);
if (!socket || !workdir || !user) {
  console.error('usage: command-host.mjs <socket> <workdir> <user>');
  process.exit(2);
}

const HEAD_BYTES = 32 * 1024;
// Above the executor's own cap; also keeps the backstop timer within setTimeout's range.
const MAX_TIMEOUT_SEC = 3600;
const TAIL_BYTES = 96 * 1024;
// A command is a few KB; the executor caps it at 8000 characters.
const MAX_BODY_BYTES = 64 * 1024;

/** The bytes as text, dropping a UTF-8 sequence cut at either end rather than decoding it to U+FFFD. */
function decodeCut(bytes, cutStart, cutEnd) {
  let start = 0;
  // Continuation bytes (10xxxxxx) at the front belong to a character that started before the cut.
  if (cutStart) while (start < bytes.length && start < 3 && (bytes[start] & 0xc0) === 0x80) start += 1;
  const decoder = new StringDecoder('utf8');
  const text = decoder.write(bytes.subarray(start));
  return cutEnd ? text : text + decoder.end();
}

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
      if (dropped === 0) return Buffer.concat([head, ...tail]).toString('utf8');
      return `${decodeCut(head, false, true)}\n…[${dropped} bytes omitted]…\n${decodeCut(Buffer.concat(tail), true, false)}`;
    },
  };
}

const killLeftovers = () => spawnSync('sudo', ['-n', 'pkill', '-KILL', '-u', user], { stdio: 'ignore' });

function runOne(command, timeoutSec) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const env = Object.entries(commandEnv(process.env, user)).map(([k, v]) => `${k}=${v}`);
    const child = spawn(
      'sudo',
      ['-n', '-u', user, '--', '/usr/bin/env', '-i', ...env, 'timeout', '--kill-after=10', String(timeoutSec), 'bash', '-c', command],
      { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // A spawn that fails at runtime emits 'error' (and maybe 'close'); settle once.
    let settled = false;
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      reject(e);
    });
    const out = capture();
    const err = capture();
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    // Backstop for a command that ignores timeout's signals.
    const guard = setTimeout(() => killLeftovers(), (timeoutSec + 30) * 1000);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      killLeftovers();
      const durationMs = Date.now() - started;
      resolve({
        exitCode: code ?? 128,
        stdout: out.text(),
        stderr: err.text(),
        // timeout(1) exits 124 on expiry, 137 after --kill-after; 137 alone is any SIGKILL (e.g. OOM).
        timedOut: code === 124 || (code === 137 && durationMs >= timeoutSec * 1000),
        durationMs,
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
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413).end('request too large');
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (size > MAX_BODY_BYTES) return;
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end('invalid json');
      return;
    }
    if (
      !body ||
      typeof body !== 'object' ||
      typeof body.command !== 'string' ||
      body.command.includes('\0') ||
      !Number.isInteger(body.timeoutSec) ||
      body.timeoutSec < 1 ||
      body.timeoutSec > MAX_TIMEOUT_SEC
    ) {
      res.writeHead(400).end(`command and timeoutSec (1-${MAX_TIMEOUT_SEC}) are required`);
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
    } catch (e) {
      // spawn throws synchronously on bad arguments and emits 'error' when it cannot start the program.
      res.writeHead(500).end(`could not run the command: ${e instanceof Error ? e.message : String(e)}`);
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
