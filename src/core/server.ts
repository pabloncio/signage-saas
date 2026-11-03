import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ApiRequest, ApiResponse, Handler } from '../shared/http.types.js';
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

const MAX_BODY_BYTES = 1_000_000;

interface Route { method: string; pattern: RegExp; paramNames: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];

  private add(method: string, path: string, ...handlers: Handler[]): void {
    const paramNames: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:([^/]+)/g, (_, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    }) + '$');
    const chained: Handler = (req, res, outerNext) => {
      let i = 0;
      const runNext = async (): Promise<void> => {
        if (i >= handlers.length) { await outerNext(); return; }
        const h = handlers[i++]!;
        await h(req, res, runNext);
      };
      return runNext();
    };
    this.routes.push({ method, pattern, paramNames, handler: chained });
  }

  get(path: string, ...h: Handler[]): void { this.add('GET', path, ...h); }
  post(path: string, ...h: Handler[]): void { this.add('POST', path, ...h); }
  put(path: string, ...h: Handler[]): void { this.add('PUT', path, ...h); }
  patch(path: string, ...h: Handler[]): void { this.add('PATCH', path, ...h); }
  delete(path: string, ...h: Handler[]): void { this.add('DELETE', path, ...h); }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => { params[name] = m[i + 1]!; });
      return { handler: route.handler, params };
    }
    return null;
  }
}

export function sendJson(res: ApiResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Errores con forma {error: {code, message}} (spec §9).
export function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function createServer(register: (router: Router) => void) {
  const router = new Router();
  register(router);

  return createHttpServer(async (rawReq, rawRes) => {
    const req = rawReq as ApiRequest;
    const res = rawRes as ApiResponse;
    const header = req.headers['x-request-id'];
    req.requestId = (Array.isArray(header) ? header[0] : header) || randomUUID();
    const startedAt = Date.now();
    const pathname = (req.url ?? '/').split('?')[0]!;

    res.on('finish', () => {
      logger.info({ requestId: req.requestId, method: req.method, path: pathname,
        status: res.statusCode, ms: Date.now() - startedAt }, 'request');
    });

    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new AppError(413, 'Cuerpo demasiado grande');
        chunks.push(Buffer.from(chunk as Buffer));
      }
      const raw = Buffer.concat(chunks).toString();
      try { req.body = raw ? JSON.parse(raw) : null; } catch { req.body = null; }

      const matched = router.match(req.method ?? 'GET', pathname);
      if (!matched) { sendJson(res, 404, errorBody('not_found', 'Ruta no encontrada')); return; }
      req.params = matched.params;
      await matched.handler(req, res, async () => {});
    } catch (err) {
      const status = err instanceof AppError ? err.statusCode : 500;
      if (status < 500) logger.warn({ requestId: req.requestId, status, msg: (err as Error).message }, 'client error');
      else logger.error({ requestId: req.requestId, err }, 'unhandled');
      if (res.headersSent) { res.end(); return; }
      sendJson(res, status, errorBody(status === 500 ? 'internal' : 'error',
        err instanceof AppError ? err.message : 'Error interno del servidor'));
    }
  });
}
