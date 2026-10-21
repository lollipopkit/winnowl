import { describe, expect, it } from 'vitest';
import { buildSourceTools, isDefinitionLine, type SourceProvider } from '../src/index.js';

describe('isDefinitionLine(find_definition 的判据)', () => {
  it.each([
    ['export function parseConfig(raw) {', 'parseConfig'],
    ['export async function parseConfig(raw: string): Promise<Config> {', 'parseConfig'],
    ['class UserStore extends Base {', 'UserStore'],
    ['export interface UserStore {', 'UserStore'],
    ['type UserStore = Map<string, User>;', 'UserStore'],
    ['const parseConfig = (raw) => {', 'parseConfig'],
    ['export const parseConfig = async (raw: string): Promise<Config> => {', 'parseConfig'],
    ['  parseConfig: function (raw) {', 'parseConfig'],
    ['def parse_config(raw):', 'parse_config'],
    ['pub fn parse_config(raw: &str) -> Config {', 'parse_config'],
    ['func ParseConfig(raw string) Config {', 'ParseConfig'],
    ['func (s *Store) ParseConfig(raw string) Config {', 'ParseConfig'],
    ['  private async parseConfig(raw: string): Promise<Config> {', 'parseConfig'],
    ['  static parseConfig(raw) {', 'parseConfig'],
  ])('definition: %s', (line, symbol) => {
    expect(isDefinitionLine(line, symbol)).toBe(true);
  });

  it.each([
    ['const cfg = parseConfig(raw);', 'parseConfig'],
    ['return parseConfig(raw);', 'parseConfig'],
    ['  await store.parseConfig(raw);', 'parseConfig'],
    ['if (parseConfig(raw)) {', 'parseConfig'],
    ['import { parseConfig } from "./config";', 'parseConfig'],
    ['export function parseConfigSafely(raw) {', 'parseConfig'],
  ])('usage: %s', (line, symbol) => {
    expect(isDefinitionLine(line, symbol)).toBe(false);
  });
});

describe('find_definition / find_references', () => {
  const files: Record<string, string> = {
    'config.ts': 'export function parseConfig(raw) {\n  return JSON.parse(raw);\n}\n',
    'app.ts': 'import { parseConfig } from "./config";\nconst cfg = parseConfig(env);\nconst other = parseConfigSafely(env);\n',
  };
  const hitsFor = (predicate: (line: string) => boolean) =>
    Object.entries(files).flatMap(([path, content]) =>
      content.split('\n').flatMap((text, i) => (predicate(text) ? [{ path, line: i + 1, text: text.trim() }] : [])),
    );
  // Without searchSymbol: searchCode (case-insensitive substring) plus a whole-word filter.
  const fallbackSource: SourceProvider = {
    listChangedFiles: async () => [],
    readFile: async (p) => files[p] ?? null,
    searchCode: async (q) => hitsFor((t) => t.toLowerCase().includes(q.toLowerCase())),
  };
  const run = async (source: SourceProvider, name: string, symbol: string) => {
    const tool = buildSourceTools(source).find((t) => t.name === name)!;
    const r = await tool.execute('id', { symbol }, undefined, undefined as never);
    return (r.content[0] as { text: string }).text;
  };

  it('definition: 只给定义行,不含调用与更长的同前缀名字', async () => {
    const out = await run(fallbackSource, 'find_definition', 'parseConfig');
    expect(out).toBe('config.ts:1\texport function parseConfig(raw) {');
  });

  it('references: 给出调用点,排除定义与更长的同前缀名字', async () => {
    const out = await run(fallbackSource, 'find_references', 'parseConfig');
    expect(out.split('\n')).toEqual(['app.ts:1\timport { parseConfig } from "./config";', 'app.ts:2\tconst cfg = parseConfig(env);']);
  });

  it('有 searchSymbol 时用它,不再走 searchCode', async () => {
    let usedSearchCode = false;
    const source: SourceProvider = {
      ...fallbackSource,
      searchCode: async () => {
        usedSearchCode = true;
        return [];
      },
      searchSymbol: async (s) => hitsFor((t) => new RegExp(`(?<![\\w$])${s}(?![\\w$])`).test(t)),
    };
    expect(await run(source, 'find_definition', 'parseConfig')).toContain('config.ts:1');
    expect(usedSearchCode).toBe(false);
  });

  it('拒绝非标识符', async () => {
    expect(await run(fallbackSource, 'find_references', 'a.b()')).toBe('"a.b()" is not an identifier.');
  });
});
