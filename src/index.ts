import { buildServer } from './app.js';
import { closePool } from './shared/db/postgres.js';
import { logger } from './shared/logger.js';

const port = Number(process.env.PORT ?? 3000);
const server = buildServer();
server.listen(port, () => logger.info({ port }, 'signage-saas escuchando'));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => server.close(() => { void closePool().finally(() => process.exit(0)); }));
}
