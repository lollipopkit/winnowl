/* global process, URL */
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** API origin of a split deployment (console on Cloudflare Pages); empty = same origin. */
const apiOrigin = process.env.VITE_API_BASE ? new URL(process.env.VITE_API_BASE).origin : undefined;

/**
 * `(marketing)` is prerendered (`/` → dist/index.html); `(app)` is a SPA. The fallback must not be
 * index.html or it would overwrite the prerendered landing page (see static/_redirects).
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    /*
     * Content-Security-Policy as a <meta> on every generated page. `hash` covers SvelteKit's own
     * bootstrap script; the theme/redirect boot code is an external file (static/boot.js), so
     * scripts never need 'unsafe-inline'. Styles keep it: components set inline style attributes.
     * frame-ancestors cannot be set from a <meta>; it comes with the other headers (static/_headers).
     */
    csp: {
      mode: 'hash',
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'style-src': ['self', 'unsafe-inline'],
        'img-src': ['self', 'data:'],
        'font-src': ['self', 'data:'],
        'connect-src': ['self', ...(apiOrigin ? [apiOrigin] : [])],
        'form-action': ['self', ...(apiOrigin ? [apiOrigin] : [])],
        'base-uri': ['self'],
        'object-src': ['none'],
      },
    },
    adapter: adapter({
      pages: 'dist',
      assets: 'dist',
      fallback: '200.html',
      precompress: false,
      strict: false,
    }),
  },
};

export default config;
