# signage-saas

Cartelería digital multiempresa: registro abierto, ubicaciones, pairing de pantallas, medios, playlists y manifiesto.
Diseño completo en [`docs/spec.md`](docs/spec.md).

## Estado

Paso 1 del plan (spec §12): esqueleto, migración base, RLS y prueba de aislamiento entre empresas.
Aún **no** hay rutas de negocio (auth, ubicaciones, dispositivos…).

## Desarrollo

```bash
docker compose up -d                 # Postgres 16
cp .env.example .env
npm install
npm run migrate                      # como dueño del esquema (MIGRATE_DATABASE_URL)
```

Crear el usuario de login de la aplicación (una vez; el rol `signage_app` lo crea la migración):

```sql
CREATE ROLE signage_login LOGIN PASSWORD 'signage' IN ROLE signage_app;
```

```bash
npm run dev
```

## Pruebas

```bash
npm test                                                           # unitarias
SIGNAGE_TEST_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npm test   # + aislamiento (RLS)
```

La prueba de aislamiento necesita un **superusuario**: crea una base temporal, migra y conecta con un rol sin privilegios, como producción.
Sin la variable se omite.

## Reglas que no se rompen

- La aplicación se conecta con un rol **que no es dueño ni superusuario** (miembro de `signage_app`). Si no, RLS no aplica.
- Todo acceso a datos de una empresa pasa por `withOrg`/`withTx`, que fija `app.org_id` con `SET LOCAL`. `organizationId` sale de la sesión, nunca del body.
- Los recursos de otra empresa responden **404**, no 403.
- Las claves foráneas entre tablas con tenant son compuestas `(organization_id, id)`.
