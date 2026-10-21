import { parseCommand, type Segment } from './shell.js';

/**
 * Not a containment boundary (the sandbox already runs repository code; network allowlist, limits
 * and absent credentials are). The rules catch an agent acting against its task (publishing,
 * pushing, uploading, probing the host) and let routine commands through without a model call.
 */
export type RuleTier = 'allow' | 'deny' | 'judge';

export interface RuleDecision {
  tier: RuleTier;
  /** Stable id of the rule that decided (audit, tests). */
  rule: string;
  reason: string;
}

/** Longer than this is not reviewed: the agent can write a script file and run that. */
export const MAX_COMMAND_CHARS = 8000;

const deny = (rule: string, reason: string): RuleDecision => ({ tier: 'deny', rule, reason });
const judge = (rule: string, reason: string): RuleDecision => ({ tier: 'judge', rule, reason });
const allow = (rule: string): RuleDecision => ({ tier: 'allow', rule, reason: 'routine command' });

/** Programs never run by an agent, whatever their arguments. */
const DENIED_PROGRAMS: Record<string, string> = {
  sudo: 'no privilege escalation in the sandbox',
  su: 'no privilege escalation in the sandbox',
  doas: 'no privilege escalation in the sandbox',
  nsenter: 'probes the sandbox boundary',
  unshare: 'probes the sandbox boundary',
  chroot: 'probes the sandbox boundary',
  mount: 'probes the sandbox boundary',
  umount: 'probes the sandbox boundary',
  insmod: 'probes the sandbox boundary',
  modprobe: 'probes the sandbox boundary',
  docker: 'no container runtime in the sandbox',
  podman: 'no container runtime in the sandbox',
  nerdctl: 'no container runtime in the sandbox',
  ctr: 'no container runtime in the sandbox',
  crictl: 'no container runtime in the sandbox',
  kubectl: 'no cluster access from the sandbox',
  ssh: 'no remote shells or transfers from the sandbox',
  scp: 'no remote shells or transfers from the sandbox',
  sftp: 'no remote shells or transfers from the sandbox',
  ftp: 'no remote shells or transfers from the sandbox',
  telnet: 'no remote shells or transfers from the sandbox',
  nc: 'no raw network connections from the sandbox',
  ncat: 'no raw network connections from the sandbox',
  netcat: 'no raw network connections from the sandbox',
  socat: 'no raw network connections from the sandbox',
  nohup: 'no background services: commands must finish',
  setsid: 'no background services: commands must finish',
  disown: 'no background services: commands must finish',
  screen: 'no background services: commands must finish',
  tmux: 'no background services: commands must finish',
  at: 'no background services: commands must finish',
  batch: 'no background services: commands must finish',
  crontab: 'no background services: commands must finish',
  systemctl: 'no background services: commands must finish',
  service: 'no background services: commands must finish',
  xmrig: 'cryptocurrency mining',
  minerd: 'cryptocurrency mining',
  cpuminer: 'cryptocurrency mining',
  ethminer: 'cryptocurrency mining',
  apt: 'system packages cannot be installed (no root); use the language package manager',
  'apt-get': 'system packages cannot be installed (no root); use the language package manager',
  apk: 'system packages cannot be installed (no root); use the language package manager',
  yum: 'system packages cannot be installed (no root); use the language package manager',
  dnf: 'system packages cannot be installed (no root); use the language package manager',
  gh: 'forge CLIs act on remote repositories',
  hub: 'forge CLIs act on remote repositories',
  glab: 'forge CLIs act on remote repositories',
};

/** Programs whose every use is routine (read, transform, build, lint, test, local files). */
const ROUTINE = new Set([
  // Shell built-ins that only change the shell's own state.
  'cd', 'pushd', 'popd', 'export', 'unset', 'set', 'shopt', 'umask',
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'tree', 'file', 'stat', 'du', 'df', 'pwd',
  'echo', 'printf', 'true', 'false', 'test', '[', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'sed', 'awk', 'jq', 'yq',
  'basename', 'dirname', 'realpath', 'readlink', 'which', 'whoami', 'id', 'uname', 'date', 'nproc', 'free',
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln', 'chmod', 'tar', 'unzip', 'zip', 'gzip', 'gunzip', 'xz', 'zcat',
  'sha256sum', 'sha1sum', 'md5sum', 'ps', 'kill', 'sleep', 'seq', 'nl', 'column', 'tee', 'patch', 'comm', 'paste',
  'tsc', 'eslint', 'prettier', 'biome', 'vitest', 'jest', 'mocha', 'ava', 'tap', 'playwright', 'svelte-check', 'vue-tsc',
  'pytest', 'ruff', 'mypy', 'pyright', 'black', 'flake8', 'isort', 'pylint', 'tox', 'nox',
  'rustc', 'rustfmt', 'clippy-driver', 'cargo-clippy', 'cargo-fmt', 'gofmt', 'golangci-lint', 'staticcheck',
  'make', 'cmake', 'ninja', 'meson', 'gcc', 'g++', 'cc', 'c++', 'clang', 'clang++', 'ld', 'ar', 'pkg-config',
  'java', 'javac', 'kotlinc', 'swift', 'swiftc', 'shellcheck', 'hadolint', 'actionlint',
]);

/** Subcommands that publish, push or log in to a registry or forge. */
const PUBLISH: Record<string, Set<string>> = {
  npm: new Set(['publish', 'unpublish', 'deprecate', 'dist-tag', 'owner', 'access', 'adduser', 'login', 'logout', 'token', 'org', 'team', 'hook', 'star']),
  pnpm: new Set(['publish', 'login', 'logout']),
  yarn: new Set(['publish', 'npm', 'login', 'logout']),
  bun: new Set(['publish']),
  cargo: new Set(['publish', 'login', 'logout', 'owner', 'yank']),
  gem: new Set(['push', 'owner', 'yank', 'signin', 'signout']),
  twine: new Set(['upload', 'register']),
  poetry: new Set(['publish']),
  uv: new Set(['publish']),
  mvn: new Set(['deploy', 'release:perform', 'release:prepare']),
  mvnw: new Set(['deploy', 'release:perform', 'release:prepare']),
  dotnet: new Set(['nuget']),
};

/** Routine subcommands of package managers and toolchains; others go to the judge. */
const ROUTINE_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(['install', 'i', 'ci', 'test', 't', 'run', 'run-script', 'ls', 'list', 'outdated', 'audit', 'view', 'pack', 'rebuild', 'prune', 'dedupe', 'version', 'why', 'explain', 'config', 'cache']),
  cargo: new Set(['build', 'b', 'test', 't', 'check', 'c', 'clippy', 'fmt', 'run', 'r', 'bench', 'doc', 'metadata', 'tree', 'fetch', 'update', 'generate-lockfile', 'nextest', 'clean', 'version', '--version', '-V']),
  go: new Set(['build', 'test', 'vet', 'fmt', 'mod', 'run', 'list', 'env', 'version', 'doc', 'work', 'clean']),
  flutter: new Set(['analyze', 'test', 'pub', 'build', 'format', '--version', 'doctor', 'gen-l10n', 'clean', 'config']),
  dart: new Set(['analyze', 'test', 'format', 'fix', 'pub', 'run', 'compile', '--version', 'doc']),
  rustup: new Set(['show', 'which', '--version', 'toolchain', 'target', 'component']),
  pip: new Set(['install', 'list', 'show', 'freeze', 'check', 'download', 'uninstall', 'wheel', '--version']),
  pip3: new Set(['install', 'list', 'show', 'freeze', 'check', 'download', 'uninstall', 'wheel', '--version']),
  poetry: new Set(['install', 'run', 'check', 'lock', 'show', 'build', 'env', 'sync']),
  uv: new Set(['sync', 'run', 'pip', 'lock', 'tree', 'build', 'venv']),
  bundle: new Set(['install', 'exec', 'check', 'list', 'update']),
  gem: new Set(['install', 'list', 'build']),
  dotnet: new Set(['build', 'test', 'restore', 'format', 'run', 'pack', 'list', '--version', '--info']),
  git: new Set(['status', 'diff', 'log', 'show', 'blame', 'branch', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'stash', 'checkout', 'switch', 'restore', 'add', 'commit', 'reset', 'apply', 'cherry-pick', 'merge-base', 'describe', 'tag', 'shortlog', 'cat-file', 'rev-list', 'diff-tree', 'whatchanged', 'reflog', 'clean', 'mv', 'rm', 'init', 'merge', 'rebase', 'revert', 'worktree', 'notes', 'format-patch']),
};

/** git subcommands that send history out. */
const GIT_OUT = new Set(['push', 'send-email', 'request-pull', 'send-pack', 'daemon', 'http-backend', 'credential', 'credential-store', 'credential-cache']);

/** Python modules run with `-m` that are routine. */
const PYTHON_MODULES = new Set(['pytest', 'unittest', 'pip', 'mypy', 'ruff', 'black', 'flake8', 'isort', 'pylint', 'compileall', 'venv', 'build', 'coverage', 'tox', 'doctest', 'py_compile']);

/** Flags that run code given on the command line. */
const INLINE_CODE: Record<string, string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python3: ['-c'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
  deno: ['eval'],
  bun: ['-e', '--eval'],
  sh: ['-c'],
  bash: ['-c'],
  dash: ['-c'],
  zsh: ['-c'],
};

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish']);
const INTERPRETERS = new Set([...SHELLS, 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno', 'bun']);

/** Text that never belongs in a routine command, wherever it appears (quoted strings included). */
const SUSPICIOUS: [RegExp, string][] = [
  [/stratum\+tcp:\/\//i, 'mentions a mining pool'],
  [/169\.254\.169\.254|metadata\.google\.internal/i, 'mentions a cloud metadata endpoint'],
  [/\/proc\/1\/(root|environ|mem)|\/proc\/self\/(mem|environ)/, 'reaches into process internals'],
  [/docker\.sock|\/sys\/fs\/cgroup|\/sys\/kernel/, 'reaches for the sandbox boundary'],
  [/\bbase64\s+(-d|--decode)|\bxxd\s+-r/, 'decodes a payload'],
  [/\/dev\/(tcp|udp)\//, 'opens a raw network connection'],
];

const base = (program: string): string => program.slice(program.lastIndexOf('/') + 1);

/** Wrappers that run another program: strip them and look at what they run. */
function unwrap(argv: string[]): { argv: string[]; decision?: RuleDecision } {
  let a = argv;
  for (let guard = 0; guard < 8 && a.length > 0; guard++) {
    const p = base(a[0]!);
    if (p === 'env') {
      let k = 1;
      while (k < a.length && (a[k]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[k]!))) k += a[k] === '-u' ? 2 : 1;
      a = a.slice(k);
    } else if (p === 'time' || p === 'command' || p === 'exec' || p === 'stdbuf') {
      let k = 1;
      while (k < a.length && a[k]!.startsWith('-')) k++;
      a = a.slice(k);
    } else if (p === 'nice') {
      let k = 1;
      while (k < a.length && a[k]!.startsWith('-')) k += a[k] === '-n' ? 2 : 1;
      a = a.slice(k);
    } else if (p === 'timeout') {
      let k = 1;
      while (k < a.length && a[k]!.startsWith('-')) k += a[k] === '-s' || a[k] === '-k' ? 2 : 1;
      a = a.slice(k + 1); // the duration
    } else if (p === 'xargs') {
      return { argv: a, decision: judge('xargs', 'runs commands built from its input') };
    } else {
      break;
    }
  }
  return { argv: a };
}

/** curl short options that take a value: the rest of the word (or the next word) is that value. */
const CURL_VALUE_FLAGS = new Set('oHuAewxmbcCErYzQ'.split(''));
const isRead = (method: string | undefined): boolean => /^(GET|HEAD|OPTIONS)$/i.test(method ?? '');

/** A curl / wget invocation that sends data (uploads, forms, posts, non-GET methods, config files). */
export function sendsData(program: string, args: readonly string[]): boolean {
  if (program !== 'curl') return args.some((a) => /^--(post-data|post-file|method|body-data|body-file)/.test(a));
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const [name, value] = a.split('=', 2) as [string, string | undefined];
      if (/^--(data.*|form.*|upload-file|json|config|ftp-.*|mail-.*)$/.test(name)) return true;
      if (name === '--request' && !isRead(value ?? args[i + 1])) return true;
      continue;
    }
    if (!a.startsWith('-') || a.length < 2) continue;
    const flags = a.slice(1);
    for (let k = 0; k < flags.length; k++) {
      const c = flags[k]!;
      // -d data, -F form, -T upload, -K config file (its contents can say anything).
      if (c === 'd' || c === 'F' || c === 'T' || c === 'K') return true;
      if (c === 'X') {
        if (!isRead(flags.slice(k + 1) || args[i + 1])) return true;
        break;
      }
      if (CURL_VALUE_FLAGS.has(c)) break;
    }
  }
  return false;
}

/** Network tools or publishing named anywhere in a command (inside a quoted script, say). */
const MENTIONS_EGRESS = /\b(curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp|telnet)\s|\bgit\s+push\b|\b(npm|pnpm|yarn|cargo|twine|poetry|gem)\s+(publish|upload|push)\b/;

function classifySegment(segment: Segment): RuleDecision {
  const unwrapped = unwrap(segment.argv);
  if (unwrapped.decision) return unwrapped.decision;
  const argv = unwrapped.argv;
  if (argv.length === 0) return allow('empty');
  const raw = argv[0]!;
  const program = base(raw);
  const args = argv.slice(1);
  const sub = args.find((a) => !a.startsWith('-'));

  if (segment.background) return deny('background', 'no background processes: commands must finish');
  if (raw.includes('$')) return judge('dynamic-program', 'the program comes from a variable');
  const denied = DENIED_PROGRAMS[program];
  if (denied) return deny(`program:${program}`, denied);

  // Something piped into an interpreter that reads its program from the pipe.
  if (segment.piped && INTERPRETERS.has(program) && (args.length === 0 || args.every((a) => a.startsWith('-')))) {
    return deny('pipe-to-interpreter', 'runs code it reads from a pipe');
  }
  const inline = INLINE_CODE[program];
  if (inline && args.some((a) => inline.includes(a))) return judge('inline-code', 'runs code given on the command line');

  const publish = PUBLISH[program];
  if (publish && sub && publish.has(sub)) return deny(`publish:${program}`, 'publishing or logging in to a registry is not part of a review or fix');
  if ((program === 'flutter' || program === 'dart') && sub === 'pub' && args.includes('publish')) {
    return deny('publish:pub', 'publishing to a registry is not part of a review or fix');
  }
  if ((program === 'gradle' || program === 'gradlew') && args.some((a) => /^(publish|upload)/i.test(a.replace(/^:?([\w-]+:)*/, '')))) {
    return deny('publish:gradle', 'publishing artifacts is not part of a review or fix');
  }

  if (program === 'git') {
    if (sub && GIT_OUT.has(sub)) return deny('git-out', 'sending history out of the sandbox is not part of a review or fix');
    if (sub && ROUTINE_SUBCOMMANDS.git!.has(sub)) return allow('git');
    return judge('git', `git ${sub ?? ''} talks to a remote or changes configuration`.trim());
  }
  if (program === 'curl' || program === 'wget') {
    if (sendsData(program, args)) return deny('upload', 'sends data out of the sandbox');
    return judge('download', 'fetches from the network');
  }
  if (program === 'rsync' && args.some((a) => /^[^/-][^/]*:|^rsync:\/\//.test(a))) {
    return deny('program:rsync', 'no remote shells or transfers from the sandbox');
  }
  if ((program === 'python' || program === 'python3') && args.includes('-m')) {
    const mod = args[args.indexOf('-m') + 1] ?? '';
    if (mod === 'http.server' || mod === 'smtpd' || mod === 'pydoc') return deny('server', 'no servers: commands must finish');
    return PYTHON_MODULES.has(mod) ? allow('python-module') : judge('python-module', `runs the module ${mod}`);
  }

  if (ROUTINE.has(program)) {
    if (program === 'rg' && args.some((a) => a === '--pre' || a.startsWith('--pre='))) return judge('exec', 'runs a command on each file');
    if (program === 'make' && args.some((a) => /^(publish|deploy|release|upload)/i.test(a))) return judge('make-target', 'a make target that may publish');
    return allow('routine');
  }
  if (program === 'find') {
    return args.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a)) ? judge('exec', 'runs commands on matches') : allow('routine');
  }

  // Package managers whose unknown subcommand is a script of the repository (`pnpm build`).
  if (program === 'pnpm' || program === 'yarn' || program === 'bun') {
    if (sub === 'dlx' || sub === 'exec' || sub === 'x' || sub === 'create') return judge('fetch-and-run', 'downloads and runs a package');
    return allow('package-manager');
  }
  if (program === 'npx' || program === 'bunx' || program === 'pipx' || program === 'uvx') return judge('fetch-and-run', 'downloads and runs a package');
  const routineSubs = ROUTINE_SUBCOMMANDS[program];
  if (routineSubs) {
    if (sub === undefined && program !== 'git') return judge('toolchain', `${program} without a subcommand`);
    return sub !== undefined && routineSubs.has(sub) ? allow('toolchain') : judge('toolchain', `${program} ${sub} is not a routine command`);
  }
  // The repository's build wrappers and its own code: what `npm test` would run anyway.
  if (program === 'gradle' || program === 'gradlew' || program === 'mvn' || program === 'mvnw') return allow('build-tool');
  if ((program === 'node' || program === 'python' || program === 'python3' || program === 'ruby') && args.length > 0 && !args[0]!.startsWith('-')) {
    return allow('run-script');
  }
  if (SHELLS.has(program)) return judge('script', 'runs a shell script');
  if (raw.includes('/')) return judge('script', 'runs a program of the repository');
  return judge('unknown', `${program} is not a routine command`);
}

/** Classifies one command line. Deny beats judge beats allow across its segments. */
export function classifyCommand(command: string): RuleDecision {
  if (command.length > MAX_COMMAND_CHARS) {
    return deny('too-long', `commands longer than ${MAX_COMMAND_CHARS} characters are not run; write a script file and run that`);
  }
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(command)) return deny('fork-bomb', 'fork bomb');
  const parsed = parseCommand(command);
  if (parsed.segments.length === 0) return deny('empty', 'empty command');
  const decisions = parsed.segments.map(classifySegment);
  const denied = decisions.find((d) => d.tier === 'deny');
  if (denied) return denied;
  if (parsed.opaque.length > 0) return judge('opaque', `cannot be read from its words: ${parsed.opaque.join(', ')}`);
  const toJudge = decisions.find((d) => d.tier === 'judge');
  if (toJudge) return toJudge;
  const suspicious = SUSPICIOUS.find(([re]) => re.test(command));
  if (suspicious) return judge('suspicious', suspicious[1]);
  if (MENTIONS_EGRESS.test(command)) return judge('mentions-egress', 'names a network or publishing tool inside its arguments');
  return decisions.length === 1 ? decisions[0]! : allow('routine');
}
