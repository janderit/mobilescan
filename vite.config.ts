import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** Short git hash of the build, so every deployed commit is distinguishable on the start page. */
function gitShortHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Writes `version.json` (`{ version, build }`) into dist/. The app fetches it
 * to detect a newer deployment (src/update.ts). It is excluded from the service
 * worker precache and served with `Cache-Control: no-cache` (public/.htaccess).
 */
function versionFile(build: string): Plugin {
  return {
    name: 'mobilescan-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version: pkg.version, build }),
      });
    },
  };
}

/**
 * Four hex characters hashed from the build moment (ISO datetime), so a redeploy
 * of an unchanged version and commit still differs from the running build and
 * the update check (src/update.ts) picks it up.
 */
function buildMomentHash(): string {
  return createHash('sha256').update(new Date().toISOString()).digest('hex').slice(0, 4);
}

/** `<git short hash>.<build moment hash>`, e.g. `1cdbefd.3f9a`. */
const build = `${gitShortHash()}.${buildMomentHash()}`;

export default defineConfig(({ mode }) => ({
  // The app lives under /app/ so the site root stays free for the product page.
  base: '/app/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(build),
  },
  server: {
    host: true,
  },
  build: {
    target: 'es2022',
  },
  plugins: [
    // Only in dev: gives the local dev server https so phones on the LAN can
    // grant camera access (getUserMedia requires a secure context). The
    // self-signed cert must be accepted once on the phone.
    ...(mode === 'development' ? [basicSsl()] : []),
    versionFile(build),
    VitePWA({
      // 'prompt': a new service worker waits instead of taking over a running
      // session; the start page's update button (src/update.ts) tells it to
      // skip waiting and reloads. Closing the app also lets it activate.
      registerType: 'prompt',
      injectRegister: 'auto',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'],
      devOptions: {
        // Keep the dev server simple: no service worker while developing.
        enabled: false,
      },
      manifest: {
        name: 'MobileScan',
        short_name: 'MobileScan',
        lang: 'de',
        description: 'Dokumente scannen und als PDF teilen',
        start_url: '/app/',
        scope: '/app/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#1e40af',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the app shell only. No runtime caching: scans and other
        // in-memory data must never be persisted (see CLAUDE.md "No retention").
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        // version.json must always come from the network (see versionFile).
        globIgnores: ['**/node_modules/**/*', 'version.json'],
        navigateFallback: '/app/index.html',
      },
    }),
  ],
}));
