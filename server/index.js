import express from 'express';
import path from 'node:path';
import { config, supabaseConfigured } from './config.js';
import { initStore } from './store.js';
import { attachSession } from './middleware.js';
import api from './routes.js';
import accountRoutes from './routes-account.js';

const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(attachSession);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use('/api', accountRoutes);
app.use('/api', api);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'workbridge', time: new Date().toISOString() });
});

const publicDir = path.join(config.root, 'public');
app.use(
  express.static(publicDir, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  })
);

// The client uses a hash router, so any non-API GET returns the app shell.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', message: 'That request is too large.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: 'Request body was not valid JSON.' });
  }
  console.error('[workbridge] unhandled error:', err);
  return res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
});

await initStore();

if (!supabaseConfigured()) {
  console.warn(
    '[workbridge] Supabase credentials not found — using the local JSON persistence driver. ' +
      'Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then run supabase/schema.sql, for production storage.'
  );
}

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[workbridge] listening on http://0.0.0.0:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

export default app;
