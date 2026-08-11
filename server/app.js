import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { BASE_CHAIN_ID } from '../src/lib/chain.js';
import { openDb } from './db.js';
import {
  createPact, getPact, listPacts, listPurchases,
  addAllocation, deleteAllocation, fundAllocation,
  syncOfferingState, syncCapTableState,
} from './pacts.js';
import { fetchLiquidSplitHoldersFromExplorer } from './explorer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sendResult(res, result) {
  res.status(result.status).json(result.body);
}

export function createApp(options = {}) {
  const app = express();
  // Production serves the Vite build output; the Vite dev server passes
  // staticDir: null and handles page/asset requests itself.
  const staticDir = 'staticDir' in options ? options.staticDir : path.join(__dirname, '..', 'dist');
  const dbPath = options.dbPath || process.env.PACT_DB_PATH || path.join(__dirname, '..', 'data', 'pact.sqlite');
  const db = options.db || openDb(dbPath);

  app.locals.db = db;
  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/pacts', (req, res) => {
    sendResult(res, createPact(db, req.body));
  });

  app.get('/api/pacts', (req, res) => {
    sendResult(res, listPacts(db, req.query));
  });

  app.get('/api/purchases', (req, res) => {
    sendResult(res, listPurchases(db, req.query));
  });

  app.get('/api/pacts/:id', (req, res) => {
    sendResult(res, getPact(db, req.params.id));
  });

  app.post('/api/pacts/:id/offering-state', (req, res) => {
    sendResult(res, syncOfferingState(db, req.params.id, req.body));
  });

  app.post('/api/pacts/:id/cap-table-state', (req, res) => {
    sendResult(res, syncCapTableState(db, req.params.id, req.body));
  });

  app.get('/api/liquid-splits/:address/holders', async (req, res) => {
    sendResult(res, await fetchLiquidSplitHoldersFromExplorer({
      liquidSplitAddress: req.params.address,
      chainId: req.query.chainId || BASE_CHAIN_ID,
    }, options.fetch || global.fetch));
  });

  app.post('/api/pacts/:id/allocations', (req, res) => {
    sendResult(res, addAllocation(db, req.params.id, req.body));
  });

  app.delete('/api/pacts/:id/allocations/:allocationId', (req, res) => {
    sendResult(res, deleteAllocation(db, req.params.id, req.params.allocationId));
  });

  app.post('/api/pacts/:id/allocations/:allocationId/fund', (req, res) => {
    sendResult(res, fundAllocation(db, req.params.id, req.params.allocationId, req.body));
  });

  if (staticDir) {
    const sendPage = file => (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(staticDir, file));
    };
    app.get('/create', sendPage('create.html'));
    app.get(['/pacts', '/pacts/'], sendPage('index.html'));
    app.get('/pacts/:id', sendPage('status.html'));
    app.get('/pacts/:id/allocations/:allocationId', sendPage('buy.html'));

    app.use(express.static(staticDir, {
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      },
    }));
  }

  return app;
}
