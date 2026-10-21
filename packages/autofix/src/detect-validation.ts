import type { ExecRequest } from '@reviewbot/sandbox';

/**
 * Detects install → lint → build → test commands from manifests; returns nothing for unknown
 * ecosystems rather than guessing.
 */
export async function detectValidationCommands(
  readFile: (path: string) => Promise<string | null>,
  /** Whether a directory exists; when given, a test command whose test directory is missing is left out. */
  isDir?: (path: string) => Promise<boolean>,
): Promise<ExecRequest[]> {
  const out: ExecRequest[] = [];
  const req = (argv: string[], purpose: ExecRequest['purpose'], timeoutMs: number): ExecRequest => ({
    argv,
    purpose,
    timeoutMs,
    maxOutputBytes: 200_000,
  });
  // Installs hit the network and are slow: longer timeout.
  const install = (argv: string[]): ExecRequest => req(argv, 'bootstrap', 600_000);

  const pkgRaw = await readFile('package.json');
  if (pkgRaw !== null) {
    const runner = await detectNodeRunner(readFile);
    // Frozen install when a lockfile exists, for reproducibility.
    if (runner === 'pnpm') out.push(install(['pnpm', 'install', '--frozen-lockfile']));
    else if (runner === 'yarn') out.push(install(['yarn', 'install', '--frozen-lockfile']));
    else out.push(install((await readFile('package-lock.json')) !== null ? ['npm', 'ci'] : ['npm', 'install']));
    let scripts: Record<string, unknown> = {};
    try {
      scripts = (JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> }).scripts ?? {};
    } catch {
      scripts = {};
    }
    // Formatters modify files, so lint is used instead.
    if (typeof scripts.lint === 'string') out.push(req([runner, 'run', 'lint'], 'lint', 120_000));
    if (typeof scripts.build === 'string') out.push(req([runner, 'run', 'build'], 'build', 300_000));
    if (typeof scripts.test === 'string') out.push(req([runner, 'run', 'test'], 'test', 300_000));
    return out;
  }

  if ((await readFile('go.mod')) !== null) {
    out.push(install(['go', 'mod', 'download']));
    out.push(req(['go', 'vet', './...'], 'lint', 120_000));
    out.push(req(['go', 'build', './...'], 'build', 300_000));
    out.push(req(['go', 'test', './...'], 'test', 300_000));
    return out;
  }

  if ((await readFile('Cargo.toml')) !== null) {
    out.push(install(['cargo', 'fetch']));
    out.push(req(['cargo', 'build'], 'build', 300_000));
    out.push(req(['cargo', 'test'], 'test', 300_000));
    return out;
  }

  const pubspec = await readFile('pubspec.yaml');
  if (pubspec !== null) {
    const isFlutter = /^\s*flutter\s*:/m.test(pubspec) || /^\s*sdk\s*:\s*flutter\s*$/m.test(pubspec);
    const tool = isFlutter ? 'flutter' : 'dart';
    out.push(install([tool, 'pub', 'get']));
    out.push(req([tool, 'analyze'], 'lint', 180_000));
    // `flutter test` / `dart test` fail outright without a test directory: nothing to run is no failure.
    if (!isDir || (await isDir('test'))) out.push(req([tool, 'test'], 'test', 300_000));
    return out;
  }

  if ((await readFile('pyproject.toml')) !== null || (await readFile('setup.py')) !== null) {
    // Prefer requirements.txt (pinned); otherwise install the project editable.
    out.push(install((await readFile('requirements.txt')) !== null ? ['pip', 'install', '-r', 'requirements.txt'] : ['pip', 'install', '-e', '.']));
    out.push(req(['python', '-m', 'pytest', '-q'], 'test', 300_000));
    return out;
  }
  if ((await readFile('requirements.txt')) !== null) {
    out.push(install(['pip', 'install', '-r', 'requirements.txt']));
    out.push(req(['python', '-m', 'pytest', '-q'], 'test', 300_000));
    return out;
  }

  return out;
}

async function detectNodeRunner(readFile: (path: string) => Promise<string | null>): Promise<string> {
  if ((await readFile('pnpm-lock.yaml')) !== null) return 'pnpm';
  if ((await readFile('yarn.lock')) !== null) return 'yarn';
  return 'npm';
}
