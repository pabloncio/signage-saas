import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { setPool, withOrg, withTx, closePool } from '../shared/db/postgres.js';

// Requiere un Postgres con un SUPERUSUARIO: SIGNAGE_TEST_ADMIN_URL=postgres://user:pass@host:5432/postgres
// Crea una base temporal, aplica las migraciones y conecta con un rol SIN privilegios, igual
// que producción. Se omite si la variable no existe.
const ADMIN_URL = process.env.SIGNAGE_TEST_ADMIN_URL;
const DB = `signage_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const LOGIN = 'signage_test_login';

function urlFor(base: string, db: string, user?: string): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = 'test'; }
  return u.toString();
}

describe.skipIf(!ADMIN_URL)('aislamiento entre empresas (RLS)', () => {
  let admin: pg.Client;
  let orgA = '', orgB = '', userA = '', locA = '', locB = '';

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${DB}`);
    await migrate(urlFor(ADMIN_URL!, DB));
    // El rol de login es de CLUSTER: se recrea si quedó de otra corrida.
    await admin.query(`DROP ROLE IF EXISTS ${LOGIN}`).catch(() => {});
    await admin.query(`CREATE ROLE ${LOGIN} LOGIN PASSWORD 'test' IN ROLE signage_app`);
    setPool(new pg.Pool({ connectionString: urlFor(ADMIN_URL!, DB, LOGIN), max: 2 }));

    // Datos de dos empresas, creados SOLO a través del rol de la aplicación.
    const plan = (await withTx({}, (c) => c.query<{ id: string }>(`SELECT id FROM plans WHERE code='free'`))).rows[0]!.id;
    userA = randomUUID(); orgA = randomUUID(); orgB = randomUUID(); locA = randomUUID(); locB = randomUUID();
    await withTx({}, (c) => c.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1,'a@x.com','h','A')`, [userA]));
    for (const [org, slug, loc] of [[orgA, 'empresa-a', locA], [orgB, 'empresa-b', locB]] as const) {
      await withOrg(org, async (c) => {
        await c.query(`INSERT INTO organizations (id, name, slug, plan_id) VALUES ($1,$2,$3,$4)`, [org, slug, slug, plan]);
        await c.query(`INSERT INTO locations (id, organization_id, name) VALUES ($1,$2,'Sede')`, [loc, org]);
        await c.query(`INSERT INTO devices (organization_id, location_id, name) VALUES ($1,$2,'TV')`, [org, loc]);
      });
    }
    await withOrg(orgA, (c) => c.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'owner')`, [orgA, userA]));
  });

  afterAll(async () => {
    await closePool();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin?.query(`DROP ROLE IF EXISTS ${LOGIN}`).catch(() => {});
    await admin?.end();
  });

  it('el rol de la aplicación no es superusuario, ni dueño, ni salta RLS', async () => {
    const r = await withTx({}, (c) => c.query(`
      SELECT rolsuper, rolbypassrls, (SELECT tableowner FROM pg_tables WHERE tablename='locations') = current_user AS owner
      FROM pg_roles WHERE rolname = current_user`));
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, owner: false });
  });

  it('sin contexto de empresa no se ve ninguna fila', async () => {
    for (const t of ['organizations', 'memberships', 'locations', 'devices']) {
      const r = await withTx({}, (c) => c.query(`SELECT count(*)::int AS n FROM ${t}`));
      expect(r.rows[0].n, t).toBe(0);
    }
  });

  it('cada empresa ve solo lo suyo', async () => {
    const a = await withOrg(orgA, (c) => c.query(`SELECT id, organization_id FROM locations`));
    expect(a.rows).toEqual([{ id: locA, organization_id: orgA }]);
    const b = await withOrg(orgB, (c) => c.query(`SELECT count(*)::int AS n FROM devices`));
    expect(b.rows[0].n).toBe(1);
  });

  it('pedir por id un recurso ajeno no devuelve nada (el servicio responderá 404)', async () => {
    const r = await withOrg(orgA, (c) => c.query(`SELECT id FROM locations WHERE id = $1`, [locB]));
    expect(r.rowCount).toBe(0);
  });

  it('no se puede modificar ni borrar lo de otra empresa', async () => {
    const up = await withOrg(orgA, (c) => c.query(`UPDATE locations SET name='hack' WHERE id=$1`, [locB]));
    const del = await withOrg(orgA, (c) => c.query(`DELETE FROM locations WHERE id=$1`, [locB]));
    expect(up.rowCount).toBe(0);
    expect(del.rowCount).toBe(0);
    const still = await withOrg(orgB, (c) => c.query(`SELECT name FROM locations WHERE id=$1`, [locB]));
    expect(still.rows[0].name).toBe('Sede');
  });

  it('no se puede insertar con el organization_id de otra empresa (WITH CHECK)', async () => {
    await expect(withOrg(orgA, (c) =>
      c.query(`INSERT INTO locations (organization_id, name) VALUES ($1,'infiltrada')`, [orgB]))).rejects.toThrow(/row-level security/);
  });

  it('una ubicación no puede colgar de la de otra empresa (FK compuesta)', async () => {
    await expect(withOrg(orgA, (c) =>
      c.query(`INSERT INTO locations (organization_id, parent_id, name) VALUES ($1,$2,'hija')`, [orgA, locB]))).rejects.toThrow();
  });

  it('un dispositivo no puede apuntar a una ubicación de otra empresa', async () => {
    await expect(withOrg(orgA, (c) =>
      c.query(`INSERT INTO devices (organization_id, location_id, name) VALUES ($1,$2,'x')`, [orgA, locB]))).rejects.toThrow();
  });

  it('el contexto no se filtra a la siguiente transacción de la misma conexión', async () => {
    await withOrg(orgA, (c) => c.query('SELECT 1'));
    // pool de 2 conexiones: se fuerzan varias vueltas para reutilizar la misma.
    for (let i = 0; i < 4; i++) {
      const r = await withTx({}, (c) => c.query(`SELECT count(*)::int AS n FROM locations`));
      expect(r.rows[0].n).toBe(0);
    }
  });

  it('un usuario lista sus empresas por membresía, sin elegir una', async () => {
    const r = await withTx({ userId: userA }, (c) => c.query(`SELECT id FROM organizations`));
    expect(r.rows.map((x) => x.id)).toEqual([orgA]);
  });

  it('un orgId que no es uuid se rechaza antes de tocar la base', async () => {
    await expect(withOrg(`x'; DROP TABLE users;--`, (c) => c.query('SELECT 1'))).rejects.toThrow(/uuid/);
  });

  it('la aplicación no puede modificar los planes', async () => {
    await expect(withTx({}, (c) => c.query(`UPDATE plans SET max_devices = 9999`))).rejects.toThrow(/permission denied/);
  });

  it('migrar dos veces no repite nada', async () => {
    expect(await migrate(urlFor(ADMIN_URL!, DB))).toEqual([]);
  });
});
