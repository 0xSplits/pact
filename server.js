// Entry point: one Node process serving the Vite build plus /api.
// The route and domain logic lives in server/.
import { pathToFileURL } from 'node:url';
import { createApp } from './server/app.js';

export { createApp };

const DEFAULT_PORT = 7228;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const host = process.env.HOST || '0.0.0.0';
  const app = createApp();
  const server = app.listen(port, host, () => {
    console.log(`PACT server listening on http://${host}:${port}`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  setInterval(() => {}, 60000);
}
