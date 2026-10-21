import { describe, expect, it } from 'vitest';
import { loadRepoConfigFromReader, loadedConfigFromLayers } from '../src/config.js';

describe('配置覆盖优先级(§37 #6:repo yaml vs 面板)', () => {
  it('有 .winnowl.yaml → hasRepoFile=true,采用 repo 值', async () => {
    const c = await loadRepoConfigFromReader(async (n) => (n === '.winnowl.yaml' ? 'reviews:\n  profile: thorough\n' : null));
    expect(c.hasRepoFile).toBe(true);
    expect(c.config.reviews.profile).toBe('thorough');
  });

  it('.winnowl.yml 亦识别 → hasRepoFile=true', async () => {
    const c = await loadRepoConfigFromReader(async (n) => (n === '.winnowl.yml' ? 'reviews:\n  profile: conservative\n' : null));
    expect(c.hasRepoFile).toBe(true);
    expect(c.config.reviews.profile).toBe('conservative');
  });

  it('无 repo 文件 → hasRepoFile=false + 默认配置', async () => {
    const c = await loadRepoConfigFromReader(async () => null);
    expect(c.hasRepoFile).toBe(false);
    expect(c.config.reviews.profile).toBe('balanced');
  });

  it('inline 名额:未设跟随 profile', async () => {
    const c = await loadRepoConfigFromReader(async (n) => (n === '.winnowl.yaml' ? 'reviews:\n  profile: conservative\n' : null));
    // Inline limit is 15 for every profile; the nit limit varies (0 for conservative).
    expect(c.noiseBudget).toEqual({ maxInlineComments: 15, maxInlinePerFile: 3, maxInlineNits: 0 });
  });

  it('inline 名额:显式设置压过 profile(逐键生效,未设的仍跟随)', async () => {
    const yaml = 'reviews:\n  profile: conservative\n  publication:\n    max_inline_comments: 20\n    max_inline_per_file: 1\n';
    const c = await loadRepoConfigFromReader(async (n) => (n === '.winnowl.yaml' ? yaml : null));
    expect(c.noiseBudget).toEqual({ maxInlineComments: 20, maxInlinePerFile: 1, maxInlineNits: 0 });
  });

  it('inline 名额:0 是有效值,不被当成"没设"', async () => {
    const yaml = 'reviews:\n  publication:\n    max_inline_comments: 0\n';
    const c = await loadRepoConfigFromReader(async (n) => (n === '.winnowl.yaml' ? yaml : null));
    expect(c.noiseBudget.maxInlineComments).toBe(0);
  });

  it('空差异片段仍是一份有效配置(面板保存过、但每个键都用默认)', () => {
    const c = loadedConfigFromLayers([{ source: 'repository-db', value: {} }]);
    expect(c.hasRepoFile).toBe(false);
    expect(c.config.reviews.profile).toBe('balanced');
    expect(c.noiseBudget.maxInlineComments).toBe(15);
  });

});
