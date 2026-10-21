import type { Severity } from '@reviewbot/findings';

// Pure dependency-vulnerability core: manifest detection, scanner output parsing, evidence rendering.

export type DependencyEcosystem = 'npm' | 'pip' | 'go' | 'cargo' | 'maven' | 'composer' | 'rubygems' | 'pub';

export interface DetectedManifest {
  ecosystem: DependencyEcosystem;
  path: string;
  kind: 'manifest' | 'lockfile';
}

// Lockfile rules come before manifests (more precise); first match wins.
const MANIFEST_RULES: { re: RegExp; ecosystem: DependencyEcosystem; kind: 'manifest' | 'lockfile' }[] = [
  { re: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/, ecosystem: 'npm', kind: 'lockfile' },
  { re: /(^|\/)package\.json$/, ecosystem: 'npm', kind: 'manifest' },
  { re: /(^|\/)(poetry\.lock|Pipfile\.lock)$/, ecosystem: 'pip', kind: 'lockfile' },
  { re: /(^|\/)requirements[^/]*\.txt$/, ecosystem: 'pip', kind: 'lockfile' },
  { re: /(^|\/)(pyproject\.toml|Pipfile)$/, ecosystem: 'pip', kind: 'manifest' },
  { re: /(^|\/)go\.sum$/, ecosystem: 'go', kind: 'lockfile' },
  { re: /(^|\/)go\.mod$/, ecosystem: 'go', kind: 'manifest' },
  { re: /(^|\/)Cargo\.lock$/, ecosystem: 'cargo', kind: 'lockfile' },
  { re: /(^|\/)Cargo\.toml$/, ecosystem: 'cargo', kind: 'manifest' },
  { re: /(^|\/)composer\.lock$/, ecosystem: 'composer', kind: 'lockfile' },
  { re: /(^|\/)Gemfile\.lock$/, ecosystem: 'rubygems', kind: 'lockfile' },
  { re: /(^|\/)pom\.xml$/, ecosystem: 'maven', kind: 'manifest' },
  // Dart/Flutter (OSV ecosystem "Pub"). osv-scanner only reads pubspec.lock; a pubspec.yaml-only change still
  // triggers the scan, which then finds Pub packages only if the repo commits pubspec.lock.
  { re: /(^|\/)pubspec\.lock$/, ecosystem: 'pub', kind: 'lockfile' },
  { re: /(^|\/)pubspec\.yaml$/, ecosystem: 'pub', kind: 'manifest' },
];

export function detectDependencyManifests(changedFiles: string[]): DetectedManifest[] {
  const out: DetectedManifest[] = [];
  for (const path of changedFiles) {
    for (const rule of MANIFEST_RULES) {
      if (rule.re.test(path)) {
        out.push({ ecosystem: rule.ecosystem, path, kind: rule.kind });
        break;
      }
    }
  }
  return out;
}

export interface DependencyVulnerability {
  ecosystem: string;
  package: string;
  installedVersion?: string;
  severity: Severity;
  /** CVE / GHSA / OSV id. */
  advisoryId: string;
  title: string;
  url?: string;
  fixedVersion?: string;
  /** Relative to the workspace; used to decide whether the change introduced it. */
  manifestPath?: string;
}

function normSeverity(s: unknown): Severity {
  const v = String(s ?? '').toLowerCase();
  if (v === 'critical') return 'critical';
  if (v === 'high') return 'high';
  if (v === 'moderate' || v === 'medium') return 'medium';
  if (v === 'low') return 'low';
  return 'info';
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** npm v7+ `vulnerabilities` map; [] on unexpected shape. */
export function parseNpmAudit(json: unknown): DependencyVulnerability[] {
  const vulns = asRecord(asRecord(json)?.vulnerabilities);
  if (!vulns) return [];
  const out: DependencyVulnerability[] = [];
  for (const [name, entryRaw] of Object.entries(vulns)) {
    const entry = asRecord(entryRaw);
    if (!entry) continue;
    const severity = normSeverity(entry.severity);
    const fix = asRecord(entry.fixAvailable);
    const fixedVersion = str(fix?.version);
    // String `via` entries are transitive references; objects are advisories.
    const advisories = asArray(entry.via).map(asRecord).filter((a): a is Record<string, unknown> => !!a && !!str(a.title));
    if (advisories.length === 0) {
      out.push({ ecosystem: 'npm', package: name, severity, advisoryId: str(entry.name) ?? name, title: `Vulnerable dependency ${name}`, ...(fixedVersion ? { fixedVersion } : {}) });
      continue;
    }
    for (const a of advisories) {
      const aUrl = str(a.url);
      const advisoryId = aUrl?.split('/').pop() ?? (a.source !== undefined ? `npm-${String(a.source)}` : name);
      out.push({
        ecosystem: 'npm',
        package: str(a.name) ?? name,
        severity: normSeverity(a.severity ?? entry.severity),
        advisoryId,
        title: str(a.title) ?? `Vulnerable dependency ${name}`,
        ...(aUrl ? { url: aUrl } : {}),
        ...(fixedVersion ? { fixedVersion } : {}),
      });
    }
  }
  return out;
}

/** [] on unexpected shape. */
export function parseOsvScanner(json: unknown): DependencyVulnerability[] {
  const out: DependencyVulnerability[] = [];
  for (const resultRaw of asArray(asRecord(json)?.results)) {
    const result = asRecord(resultRaw);
    const manifestPath = str(asRecord(result?.source)?.path);
    for (const pkgRaw of asArray(result?.packages)) {
      const pkg = asRecord(pkgRaw);
      const pi = asRecord(pkg?.package);
      const name = str(pi?.name) ?? 'unknown';
      const ecosystem = str(pi?.ecosystem) ?? 'unknown';
      const installedVersion = str(pi?.version);
      for (const vulnRaw of asArray(pkg?.vulnerabilities)) {
        const v = asRecord(vulnRaw);
        if (!v) continue;
        const dbSpecific = asRecord(v.database_specific);
        // Advisories often have one fixed version per major range: take the smallest above the
        // installed version, or the largest when the installed version is unknown.
        const fixes: string[] = [];
        for (const affRaw of asArray(v.affected)) {
          for (const rangeRaw of asArray(asRecord(affRaw)?.ranges)) {
            for (const evRaw of asArray(asRecord(rangeRaw)?.events)) {
              const fixed = str(asRecord(evRaw)?.fixed);
              if (fixed) fixes.push(fixed);
            }
          }
        }
        const fixedVersion = applicableFix(fixes, installedVersion);
        const url = str(asRecord(asArray(v.references)[0])?.url);
        out.push({
          ecosystem,
          package: name,
          ...(installedVersion ? { installedVersion } : {}),
          severity: normSeverity(dbSpecific?.severity ?? asRecord(asArray(v.severity)[0])?.score),
          advisoryId: str(v.id) ?? 'UNKNOWN',
          title: str(v.summary) ?? str(v.id) ?? `Vulnerability in ${name}`,
          ...(url ? { url } : {}),
          ...(fixedVersion ? { fixedVersion } : {}),
          ...(manifestPath ? { manifestPath } : {}),
        });
      }
    }
  }
  return out;
}

export function renderDependencyEvidence(vulns: DependencyVulnerability[]): string {
  if (vulns.length === 0) return 'No known dependency vulnerabilities from deterministic scanners.';
  const lines = vulns.map((v) => `- [${v.severity}] ${v.package}${v.installedVersion ? `@${v.installedVersion}` : ''} — ${v.advisoryId}: ${v.title}${v.fixedVersion ? ` (fix: ${v.fixedVersion})` : ''}`);
  return `Deterministic dependency scan (npm audit / osv-scanner) found ${vulns.length} advisory(ies):\n${lines.join('\n')}`;
}

/** Ignores prerelease/build suffixes; non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Smallest fixed version above the installed one; the largest when installed is unknown. */
export function applicableFix(fixes: readonly string[], installed: string | undefined): string | undefined {
  if (fixes.length === 0) return undefined;
  const sorted = [...fixes].sort(compareVersions);
  if (!installed) return sorted.at(-1);
  return sorted.find((f) => compareVersions(f, installed) > 0) ?? sorted.at(-1);
}

export interface DependencyVulnerabilityGroup {
  ecosystem: string;
  package: string;
  installedVersion?: string;
  manifestPath?: string;
  severity: Severity;
  advisories: { id: string; severity: Severity; title: string }[];
  /** Lowest version fixing every advisory in the group; absent if any advisory has no fix. */
  fixedVersion?: string;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** Merges advisories for the same package version in one manifest: the fix is one upgrade. */
export function groupVulnerabilities(vulns: readonly DependencyVulnerability[]): DependencyVulnerabilityGroup[] {
  const groups = new Map<string, DependencyVulnerabilityGroup & { fixes: (string | undefined)[] }>();
  for (const v of vulns) {
    const key = [v.ecosystem, v.package, v.installedVersion ?? '', v.manifestPath ?? ''].join('\0');
    const g =
      groups.get(key) ??
      {
        ecosystem: v.ecosystem,
        package: v.package,
        ...(v.installedVersion ? { installedVersion: v.installedVersion } : {}),
        ...(v.manifestPath ? { manifestPath: v.manifestPath } : {}),
        severity: v.severity,
        advisories: [],
        fixes: [],
      };
    if (!g.advisories.some((a) => a.id === v.advisoryId)) {
      g.advisories.push({ id: v.advisoryId, severity: v.severity, title: v.title });
      g.fixes.push(v.fixedVersion);
    }
    if (SEVERITY_RANK[v.severity] > SEVERITY_RANK[g.severity]) g.severity = v.severity;
    groups.set(key, g);
  }
  return [...groups.values()].map(({ fixes, ...g }) => {
    g.advisories.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.id.localeCompare(b.id));
    const fixedVersion = fixes.every((f): f is string => f !== undefined)
      ? [...fixes].sort(compareVersions).at(-1)
      : undefined;
    return { ...g, ...(fixedVersion ? { fixedVersion } : {}) };
  });
}
