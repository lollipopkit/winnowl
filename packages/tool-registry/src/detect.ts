import type { ProjectContext } from './types.js';

export type ReadFile = (path: string) => Promise<string | null>;

/** Language-agnostic: commands come from manifests; undetected commands stay empty. */
export async function detectProject(readFile: ReadFile): Promise<ProjectContext> {
  const languages = new Set<string>();
  const commands = { build: [] as string[], lint: [] as string[], test: [] as string[] };

  const pkg = await readFile('package.json');
  if (pkg) {
    languages.add('javascript');
    try {
      const json = JSON.parse(pkg) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = json.scripts ?? {};
      if (scripts.build) commands.build = ['npm', 'run', 'build'];
      if (scripts.lint) commands.lint = ['npm', 'run', 'lint'];
      if (scripts.test) commands.test = ['npm', 'run', 'test'];
      if (json.dependencies?.typescript || json.devDependencies?.typescript) {
        languages.add('typescript');
      }
    } catch {
      // An invalid package.json must not block detection.
    }
  }

  if (await readFile('go.mod')) {
    languages.add('go');
    commands.build = ['go', 'build', './...'];
    commands.lint = ['go', 'vet', './...'];
    commands.test = ['go', 'test', './...'];
  }

  if (await readFile('Cargo.toml')) {
    languages.add('rust');
    commands.build = ['cargo', 'build'];
    commands.lint = ['cargo', 'clippy'];
    commands.test = ['cargo', 'test'];
  }

  if ((await readFile('pyproject.toml')) || (await readFile('setup.py'))) {
    languages.add('python');
  }

  return { languages: [...languages], commands };
}
