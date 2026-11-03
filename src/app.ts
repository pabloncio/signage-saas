import { createServer, sendJson, type Router } from './core/server.js';
import { getPool } from './shared/db/postgres.js';

export function register(router: Router): void {
  // Liveness simple; /ready comprueba la base.
  router.get('/health', (_req, res) => sendJson(res, 200, { status: 'ok' }));
  router.get('/ready', async (_req, res) => {
    try { await getPool().query('SELECT 1'); sendJson(res, 200, { status: 'ready' }); }
    catch { sendJson(res, 503, { error: { code: 'db_unavailable', message: 'Base de datos no disponible' } }); }
  });
}

export const buildServer = () => createServer(register);
