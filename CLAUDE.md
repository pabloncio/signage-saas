# CLAUDE.md

Servicio independiente de cartelería digital (SaaS). Spec: `docs/spec.md`. Origen del código de contenido: `services/signage` de `kraken-core-business` (sin relación funcional con Kraken).

## Comandos
- `npm run dev` / `npm run build` / `npm run migrate` / `npm test`
- Aislamiento (RLS): `SIGNAGE_TEST_ADMIN_URL=postgres://… npm test` (necesita superusuario; crea y borra una base temporal).

## Reglas
- TypeScript `NodeNext`: los imports locales llevan extensión `.js`. `strict` + `noUncheckedIndexedAccess`.
- Servidor HTTP propio (`src/core/server.ts`), sin Express. Errores `{error:{code,message}}`.
- **Multiempresa**: toda tabla con datos de una empresa lleva `organization_id`, RLS `ENABLE`+`FORCE` y política `organization_id = app_org()`. Todo acceso pasa por `withOrg`/`withTx` (`src/shared/db/postgres.ts`). El `organizationId` nunca viene del body.
- La app se conecta con un rol miembro de `signage_app` (no dueño, sin BYPASSRLS). Las migraciones usan otro rol (`MIGRATE_DATABASE_URL`).
- FK entre tablas con tenant: compuestas `(organization_id, id)`.
- Una tabla nueva con tenant = migración nueva + RLS + test de aislamiento en `src/__tests__/isolation.integration.test.ts`. Las migraciones aplicadas no se editan: se agrega otra.
- Un recurso ajeno responde 404, nunca 403.
- Nunca se loguean cuerpos de request, contraseñas ni tokens.
