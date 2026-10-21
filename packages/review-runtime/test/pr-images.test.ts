import { describe, expect, it } from 'vitest';
import { extractImageUrls, fetchPrImages, isAllowedImageUrl } from '../src/pr-images.js';

const GH = { provider: 'github' } as const;

describe('extractImageUrls(PR/issue 正文)', () => {
  it('markdown 与 <img> 两种写法都认(GitHub 两种都渲染,只认一种等于漏一半)', () => {
    const md = [
      '看这个界面 ![before](https://user-images.githubusercontent.com/1/a.png)',
      '<img src="https://user-images.githubusercontent.com/1/b.png" width="400">',
      '![带尖括号](<https://user-images.githubusercontent.com/1/c%20d.png>)',
    ].join('\n');
    expect(extractImageUrls(md)).toEqual([
      'https://user-images.githubusercontent.com/1/a.png',
      'https://user-images.githubusercontent.com/1/c%20d.png',
      'https://user-images.githubusercontent.com/1/b.png',
    ]);
  });

  it('重复的只出一次;没有图片则空', () => {
    const u = 'https://user-images.githubusercontent.com/1/a.png';
    expect(extractImageUrls(`![x](${u}) ![y](${u})`)).toEqual([u]);
    expect(extractImageUrls('普通文字 [链接](https://example.com)')).toEqual([]);
  });
});

// The host allowlist is a security boundary: otherwise the PR author picks which host we connect to.
describe('isAllowedImageUrl(只放行 provider 自己的域)', () => {
  it('GitHub 的用户内容域放行', () => {
    for (const u of [
      'https://user-images.githubusercontent.com/1/a.png',
      'https://private-user-images.githubusercontent.com/1/a.png',
      'https://github.com/acme/app/assets/1/a.png',
    ]) {
      expect(isAllowedImageUrl(u, GH)).toBe(true);
    }
  });

  it('自建实例:附件挂在实例自身 origin 下 → 放行,别的 origin 不放', () => {
    const p = { provider: 'forgejo', instanceOrigin: 'https://git.acme.com' };
    expect(isAllowedImageUrl('https://git.acme.com/attachments/1', p)).toBe(true);
    expect(isAllowedImageUrl('https://git.evil.com/attachments/1', p)).toBe(false);
  });

  it('名单外一律不取 —— 包括常见图床与内网地址', () => {
    for (const u of [
      'https://i.imgur.com/a.png',
      'https://example.com/a.png',
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/a.png',
      'https://user-images.githubusercontent.com.evil.com/a.png', // suffix spoofing
    ]) {
      expect(isAllowedImageUrl(u, GH)).toBe(false);
    }
  });

  it('非 https 与相对路径不取(明文往返走的是客户截图;相对路径的 base 只能猜)', () => {
    expect(isAllowedImageUrl('http://user-images.githubusercontent.com/a.png', GH)).toBe(false);
    expect(isAllowedImageUrl('/uploads/a.png', GH)).toBe(false);
    expect(isAllowedImageUrl('data:image/png;base64,AAA', GH)).toBe(false);
  });
});

describe('fetchPrImages(取图)', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const okRes = (mime = 'image/png', body: Buffer = png): Response =>
    new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': mime } });

  it('只取放行的,按上限截断', async () => {
    const seen: string[] = [];
    const images = await fetchPrImages(
      [
        'https://i.imgur.com/nope.png',
        'https://user-images.githubusercontent.com/1/a.png',
        'https://user-images.githubusercontent.com/1/b.png',
        'https://user-images.githubusercontent.com/1/c.png',
      ],
      GH,
      {
        maxImages: 2,
        fetchImpl: (async (u: string) => {
          seen.push(String(u));
          return okRes();
        }) as unknown as typeof fetch,
      },
    );
    expect(seen).toEqual([
      'https://user-images.githubusercontent.com/1/a.png',
      'https://user-images.githubusercontent.com/1/b.png',
    ]); // the off-list URL was never requested
    expect(images.map((i) => i.mimeType)).toEqual(['image/png', 'image/png']);
    expect(images[0]!.data).toBe(png.toString('base64'));
  });

  it('SVG 不收(可带脚本的 XML,不是位图);超大的不收', async () => {
    const svg = await fetchPrImages(['https://user-images.githubusercontent.com/1/a.svg'], GH, {
      fetchImpl: (async () => okRes('image/svg+xml')) as unknown as typeof fetch,
    });
    expect(svg).toEqual([]);
    const big = await fetchPrImages(['https://user-images.githubusercontent.com/1/a.png'], GH, {
      maxBytes: 2,
      fetchImpl: (async () => okRes('image/png', Buffer.alloc(10))) as unknown as typeof fetch,
    });
    expect(big).toEqual([]);
  });

  it('单张失败只跳过它,不拖垮其余(图片是背景信息,不是结论依据)', async () => {
    const images = await fetchPrImages(
      ['https://user-images.githubusercontent.com/1/a.png', 'https://user-images.githubusercontent.com/1/b.png'],
      GH,
      {
        fetchImpl: (async (u: string) => {
          if (String(u).endsWith('a.png')) throw new Error('boom');
          return okRes();
        }) as unknown as typeof fetch,
      },
    );
    expect(images.map((i) => i.url)).toEqual(['https://user-images.githubusercontent.com/1/b.png']);
  });
});
