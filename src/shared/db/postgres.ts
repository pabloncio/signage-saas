import pg from 'pg';
import { logger } from '../logger.js';

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.POSTGRES_URI,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (err) => logger.error({ err }, '[Postgres] error en el pool'));
  }
  return pool;
}

/** Para tests: inyecta un pool ya conectado con el rol de la aplicación. */
export function setPool(p: pg.Pool | undefined): void { pool = p; }

export async function closePool(): Promise<void> { await pool?.end(); pool = undefined; }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, what: string): void {
  if (!UUID.test(value)) throw new Error(`${what} no es un uuid`);
}

export interface TenantContext { orgId?: string; userId?: string }

/**
 * Corre `fn` en UNA transacción con el contexto de seguridad fijado con SET LOCAL
 * (set_config(..., true)): vale solo hasta el COMMIT/ROLLBACK, así que no se filtra a la
 * siguiente request que reciba esa conexión del pool. Toda lectura/escritura de datos de
 * una empresa debe pasar por aquí: sin `app.org_id` las políticas RLS no devuelven filas.
 */
export async function withTx<T>(ctx: TenantContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  if (ctx.orgId) assertUuid(ctx.orgId, 'orgId');
  if (ctx.userId) assertUuid(ctx.userId, 'userId');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (ctx.orgId) await client.query(`SELECT set_config('app.org_id', $1, true)`, [ctx.orgId]);
    if (ctx.userId) await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const withOrg = <T>(orgId: string, fn: (c: pg.PoolClient) => Promise<T>, userId?: string): Promise<T> =>
  withTx({ orgId, userId }, fn);
