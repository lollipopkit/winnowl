/**
 * Public-page site metadata, shared by the landing page head and build-time robots/sitemap.
 * Not localized: crawlers only ever see the prerendered English page.
 */

/** Absolute URLs are required and prerendering has no `location`, so the build provides it. Trailing slashes stripped. */
export const SITE_URL: string = (
  import.meta.env.VITE_SITE_URL ?? 'https://winnowl.lollipopkit.com'
).replace(/\/+$/, '');

export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

export const SITE_NAME = 'Winnowl';

/** Kept within 60 / 160 chars so search results do not truncate them. */
export const LANDING_TITLE = 'Winnowl — AI code review that verifies before it posts';

export const LANDING_DESCRIPTION =
  'Open-source AI code review for GitHub, GitLab and Forgejo. Every finding is verified and challenged before it is posted. Self-hostable, Apache-2.0.';

export const REPO_URL = 'https://github.com/lollipopkit/winnowl';

/** 1200x630; crawlers require an absolute URL (see `absoluteUrl`). */
export const OG_IMAGE_PATH = '/og-image.png';

/** JSON embedded in a script element must not contain a literal `<` (`</script>` breakout). */
export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Only fields verifiable from the product itself; no `aggregateRating`/`offers` (structured-data penalties). */
export function landingJsonLd(): string {
  return safeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Web',
    url: absoluteUrl('/'),
    description: LANDING_DESCRIPTION,
    sameAs: [REPO_URL],
  });
}
