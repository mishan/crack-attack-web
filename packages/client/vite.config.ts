import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// Resolve the workspace packages to their TypeScript source so `vite dev`/`build`
// don't require a prior `tsc -b`, and — critically — never pick up a *stale*
// built `dist` (e.g. an old PROTOCOL_VERSION or codec that silently drops new
// message fields). Vite compiles the source inline.
const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));
const protocolSrc = fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url));
const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Link previews (Facebook, LinkedIn, …) need the page's address and its
 * preview image (`public/og-image.png`) as absolute URLs, so those tags go in
 * only when the build knows where the game is served: `VITE_PUBLIC_URL`
 * (e.g. `https://example.com/`).
 */
function linkPreviewUrls(publicUrl: string | undefined): Plugin {
  const base = parsePublicUrl(publicUrl);
  return {
    name: 'link-preview-urls',
    transformIndexHtml() {
      if (!base) return [];
      const meta = (property: string, content: string) =>
        ({ tag: 'meta', attrs: { property, content }, injectTo: 'head' }) as const;
      return [
        meta('og:url', base),
        meta('og:image', `${base}og-image.png`),
        meta('og:image:width', '1200'),
        meta('og:image:height', '630'),
      ];
    },
  };
}

/**
 * `VITE_PUBLIC_URL`, checked: an absolute http(s) address without a query or
 * hash, given a trailing slash; unset = undefined. Anything else fails the
 * build, rather than ship relative preview URLs (`example.com` alone, say).
 */
function parsePublicUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL | null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (!url || !/^https?:$/.test(url.protocol) || url.search || url.hash) {
    throw new Error(
      `VITE_PUBLIC_URL must be the game's full http(s) address, e.g. https://example.com/ (got ${JSON.stringify(raw)})`,
    );
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

export default defineConfig(({ mode }) => ({
  // The package directory is the Vite root (index.html lives here).
  root,
  plugins: [linkPreviewUrls(loadEnv(mode, root, 'VITE_')['VITE_PUBLIC_URL'])],
  // Relative asset paths so the built bundle works when served from any
  // subdirectory (e.g. a sub-path deploy), not just the domain root. Note: the
  // app must still be *served over HTTP* — opening dist/web/index.html directly
  // via file:// won't load ES modules. Use `pnpm --filter @crack-attack/client
  // dev`, or `… preview` after a build.
  base: './',
  resolve: {
    alias: {
      '@crack-attack/core': coreSrc,
      '@crack-attack/protocol': protocolSrc,
    },
  },
  build: {
    // Keep the bundle under the already-gitignored dist/ (tsc emits type stubs
    // to dist/*, Vite emits the web bundle to dist/web/*; no collision).
    outDir: 'dist/web',
    emptyOutDir: true,
    // The three.js core chunk (below) is ~560 kB on its own and deliberately
    // kept whole; warn only if a chunk grows past it.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // three.js core in a chunk of its own: it's most of the first-load bytes
        // and changes far less often than the game code, so returning players
        // keep it cached across deploys instead of re-downloading it every
        // release. Only `three/build` (the core) — add-ons under
        // `three/examples` (the glTF loader) stay in their own lazy chunks.
        codeSplitting: {
          groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]build[\\/]/ }],
        },
      },
    },
  },
}));
