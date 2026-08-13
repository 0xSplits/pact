import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Connect, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

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

export default defineConfig({
  appType: 'mpa',
  plugins: [react(), tailwindcss(), cleanRoutes],
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
});
