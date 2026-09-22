import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => ({
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
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/icon-192.png'],
      devOptions: {
        // Keep the dev server simple: no service worker while developing.
        enabled: false,
      },
      manifest: {
        name: 'MobileScan',
        short_name: 'MobileScan',
        lang: 'de',
        description: 'Dokumente scannen und als PDF teilen',
        start_url: '/',
        scope: '/',
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
        ],
      },
      workbox: {
        // Precache the app shell only. No runtime caching: scans and other
        // in-memory data must never be persisted (see CLAUDE.md "No retention").
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
}));
