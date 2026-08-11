import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const page = name => fileURLToPath(new URL(name, import.meta.url));

function cleanRouteHtml(url) {
  const pathname = new URL(url, 'http://pact.local').pathname;
  if (pathname === '/create') return '/create.html';
  if (pathname === '/pacts' || pathname === '/pacts/') return '/index.html';
  if (/^\/pacts\/[^/]+\/?$/.test(pathname)) return '/status.html';
  if (/^\/pacts\/[^/]+\/allocations\/[^/]+\/?$/.test(pathname)) return '/buy.html';
  return null;
}

// Mounts the Express API (server.js) inside the Vite dev server so `npm run dev`
// is a single process. Unmatched requests fall through to Vite's middleware.
const pactApi = {
  name: 'pact-api',
  apply: 'serve',
  async configureServer(server) {
    const { createApp } = await import('./server.js');
    server.middlewares.use(createApp({ staticDir: null }));
    server.middlewares.use((req, res, next) => {
      const target = req.url && cleanRouteHtml(req.url);
      if (target) req.url = target;
      next();
    });
  },
};

export default defineConfig({
  appType: 'mpa',
  plugins: [react(), tailwindcss(), pactApi],
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
