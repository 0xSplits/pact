import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Connect, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const localCertificate = page('.tmp/localhost.pem');
const localCertificateKey = page('.tmp/localhost-key.pem');
const localHttps = existsSync(localCertificate) && existsSync(localCertificateKey)
  ? { cert: readFileSync(localCertificate), key: readFileSync(localCertificateKey) }
  : undefined;

// Dev/preview-server equivalent of static-host cleanUrls: /create → create.html etc.
const rewriteCleanUrls: Connect.NextHandleFunction = (req, res, next) => {
  const pathname = new URL(req.url || '/', 'http://pact.local').pathname;
  const target = ({ '/create': '/create.html', '/status': '/status.html', '/buy': '/buy.html' } as Record<string, string>)[pathname];
  if (target && req.url) req.url = target + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  next();
};
const cleanRoutes: Plugin = {
  name: 'pact-clean-routes',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use(rewriteCleanUrls);
  },
  configurePreviewServer(server) {
    server.middlewares.use(rewriteCleanUrls);
  },
};

export default defineConfig(({ isPreview }) => ({
  appType: 'mpa',
  plugins: [react(), tailwindcss(), cleanRoutes],
  server: { https: isPreview ? undefined : localHttps },
  // Playwright targets a stable HTTP preview URL. A developer's trusted
  // localhost certificate must not silently change the E2E server protocol.
  build: {
    rollupOptions: {
      input: {
        index: page('index.html'),
        create: page('create.html'),
        status: page('status.html'),
        buy: page('buy.html'),
      },
    },
  },
}));
