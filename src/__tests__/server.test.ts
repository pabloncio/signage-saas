import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, sendJson } from '../core/server.js';
import { assertUuid } from '../shared/db/postgres.js';
import { NotFoundError } from '../shared/errors.js';

const server = createServer((r) => {
  r.get('/ping/:id', (req, res) => sendJson(res, 200, { id: req.params.id }));
  r.get('/boom', () => { throw new Error('secreto interno'); });
  r.get('/nf', () => { throw new NotFoundError('No encontrado'); });
  r.post('/echo', (req, res) => sendJson(res, 200, { body: req.body }));
});
let base = '';
beforeAll(async () => { await new Promise<void>((ok) => server.listen(0, ok)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

describe('servidor HTTP', () => {
  it('extrae parámetros de ruta', async () => {
    expect(await (await fetch(`${base}/ping/abc`)).json()).toEqual({ id: 'abc' });
  });
  it('404 con forma {error:{code,message}}', async () => {
    const res = await fetch(`${base}/nada`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });
  it('un error interno no filtra su mensaje', async () => {
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secreto');
  });
  it('un AppError conserva su status', async () => {
    expect((await fetch(`${base}/nf`)).status).toBe(404);
  });
  it('rechaza cuerpos enormes con 413', async () => {
    const res = await fetch(`${base}/echo`, { method: 'POST', body: 'x'.repeat(1_100_000) });
    expect(res.status).toBe(413);
  });
});

describe('assertUuid', () => {
  it('acepta uuid y rechaza inyección', () => {
    expect(() => assertUuid('3f2b8c1e-6a4d-4b7e-9c10-1a2b3c4d5e6f', 'x')).not.toThrow();
    expect(() => assertUuid(`x'; DROP TABLE users;--`, 'x')).toThrow();
  });
});
