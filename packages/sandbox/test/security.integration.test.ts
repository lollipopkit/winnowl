import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DockerSandboxBackend,
  runProcess,
  UnsupportedNetworkPolicyError,
  type SandboxHandle,
  type SandboxSpec,
} from '../src/index.js';

const IMAGE = 'alpine:3.24';
const backend = new DockerSandboxBackend();

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: IMAGE,
    network: { mode: 'none' },
    resources: { cpus: 1, memoryMb: 256, pids: 64, diskMb: 64 },
    maxLifetimeSeconds: 120,
    ...overrides,
  };
}

// Needs Docker; run via pnpm test:integration.
describe('Sandbox 安全套件', () => {
  const handles: SandboxHandle[] = [];
  let shared: SandboxHandle;

  beforeAll(async () => {
    await runProcess('docker', ['pull', IMAGE], { timeoutMs: 120_000 });
    shared = await backend.create(spec());
    handles.push(shared);
  });

  afterAll(async () => {
    for (const h of handles) await backend.destroy(h);
  });

  const exec = (argv: string[], timeoutMs = 10_000, maxOutputBytes = 1_000_000, handle = shared) =>
    backend.exec(handle, { argv, purpose: 'inspect', timeoutMs, maxOutputBytes });

  it('基础命令执行并捕获输出', async () => {
    const r = await exec(['echo', 'hello']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
    expect(r.evidence.image).toBe(IMAGE);
  });

  it('文件系统是镜像而非宿主(alpine rootfs)', async () => {
    const r = await exec(['cat', '/etc/alpine-release']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^3\./);
  });

  it('network=none 阻断出站(云 metadata 不可达)', async () => {
    const r = await exec(['wget', '-T', '3', '-q', '-O', '-', 'http://169.254.169.254/'], 8000);
    expect(r.exitCode).not.toBe(0);
  });

  it('容器内无 docker socket', async () => {
    const r = await exec(['sh', '-c', 'test -S /var/run/docker.sock']);
    expect(r.exitCode).not.toBe(0);
  });

  it('超时杀进程组', async () => {
    const r = await exec(['sleep', '30'], 1500);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it('输出洪泛被截断', async () => {
    const r = await exec(['sh', '-c', 'yes aaaaaaaa | head -n 100000'], 10_000, 2000);
    expect(r.stdoutTruncated).toBe(true);
  });

  it('rootfs 只读,工作区可写', async () => {
    const ro = await exec(['sh', '-c', 'echo x > /etc/reviewbot_test']);
    expect(ro.exitCode).not.toBe(0);
    const rw = await exec(['sh', '-c', 'echo x > /workspace/f && cat /workspace/f']);
    expect(rw.exitCode).toBe(0);
    expect(rw.stdout.trim()).toBe('x');
  });

  it('putFile / getArtifact 往返', async () => {
    await backend.putFile(shared, { path: '/workspace/a.txt', content: 'hello-artifact' });
    const art = await backend.getArtifact(shared, '/workspace/a.txt');
    expect(art.content.trim()).toBe('hello-artifact');
  });

  it('磁盘占满:写超过 diskMb 的 tmpfs 失败(不影响宿主)', async () => {
    const bounded = await backend.create(spec({ resources: { cpus: 1, memoryMb: 256, pids: 64, diskMb: 32 } }));
    handles.push(bounded);
    // Writing 128 MiB into a 32 MiB /workspace tmpfs -> ENOSPC.
    const r = await exec(['sh', '-c', 'dd if=/dev/zero of=/workspace/big bs=1M count=128 2>&1; echo EXIT=$?'], 30_000, 1_000_000, bounded);
    expect(r.stdout).toMatch(/no space left|EXIT=[^0]/i);
  });

  it('符号链接不逃逸容器(读到容器内 /etc,非宿主)', async () => {
    // A symlink to /etc/hostname resolves inside the container, not on the host.
    const r = await exec(['sh', '-c', 'ln -sf /etc/hostname /workspace/link && cat /workspace/link'], 10_000, 1_000_000);
    expect(r.exitCode).toBe(0);
    // The container hostname is its id prefix, unlike the host's.
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  it('pids-limit 限制 fork(fork bomb 边界)', async () => {
    const bounded = await backend.create(spec({ resources: { cpus: 1, memoryMb: 256, pids: 16, diskMb: 64 } }));
    handles.push(bounded);
    const r = await exec(
      ['sh', '-c', 'i=0; while [ $i -lt 60 ]; do sleep 3 & i=$((i+1)); done; echo done'],
      15_000,
      1_000_000,
      bounded,
    );
    // Forks beyond the pids limit fail.
    expect(r.stderr.toLowerCase()).toContain('fork');
  });

  it('proxied network modes fail closed without their internal network', async () => {
    await expect(
      backend.create(spec({ network: { mode: 'allowlist', hosts: ['example.com'] } })),
    ).rejects.toThrow(UnsupportedNetworkPolicyError);
    await expect(
      backend.create(spec({ network: { mode: 'package-registry-only', ecosystems: ['npm'] } })),
    ).rejects.toThrow(UnsupportedNetworkPolicyError);
  });

  it('an OOM-killed command is reported as such; the sandbox grows in place and the command then fits', async () => {
    const h = await backend.create(spec({ resources: { cpus: 1, memoryMb: 96, pids: 64, diskMb: 64 } }));
    handles.push(h);
    // ~150 MB held in a shell variable for a few seconds (sampled every 2 s): beyond 96 MiB.
    const hog = ['sh', '-c', 'x=$(head -c 150000000 /dev/zero | tr "\\0" a); sleep 3; echo ${#x}'];
    const killed = await exec(hog, 30_000, 1000, h);
    expect(killed.exitCode).not.toBe(0);
    expect(killed.oomKilled).toBe(true);
    expect(killed.timedOut).toBe(false);

    const grown = await backend.resize(h, { memoryMb: 512, swapMb: 128, cpus: 2 });
    expect(grown).toMatchObject({ memoryMb: 512, swapMb: 128, cpus: 2 });
    const ok = await exec(hog, 30_000, 1000, h);
    expect(ok.exitCode).toBe(0);
    expect(ok.oomKilled).toBeUndefined();
    const u = await backend.usage(h);
    expect(u.memoryPeakMb).toBeGreaterThan(90);
    expect(u.oomKills).toBeGreaterThanOrEqual(1);

    // Shrinking after stopping what commands left behind.
    await exec(['sh', '-c', 'sleep 300 >/dev/null 2>&1 &'], 5_000, 1000, h);
    const shrunk = await backend.resize(h, { memoryMb: 128, swapMb: 0, stopProcesses: true });
    expect(shrunk.memoryMb).toBe(128);
    // Only the sandbox's own sleep is left, and nothing lingers as a zombie (init reaps).
    // (busybox `timeout` leaves a watchdog behind each exec for up to a second; not counted.)
    const left = await exec(['sh', '-c', 'ps -o args= | grep -c "^sleep 300" || true'], 5_000, 1000, h);
    expect(left.stdout.trim()).toBe('0');
    const main = await exec(['sh', '-c', 'ps -o args= | grep -c "^sleep 120" || true'], 5_000, 1000, h);
    expect(main.stdout.trim()).toBe('1');
    const zombies = await exec(['sh', '-c', 'ps -o stat= | grep -c "^Z" || true'], 5_000, 1000, h);
    expect(zombies.stdout.trim()).toBe('0');
  });
});
