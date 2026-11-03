-- Base multiempresa. Ver docs/spec.md §4 (aislamiento) y §5 (modelo).

-- Rol de la APLICACIÓN. NOLOGIN: el despliegue crea un usuario de login y lo hace miembro
-- (GRANT signage_app TO <login>). Sin BYPASSRLS y sin ser dueño de las tablas, para que las
-- políticas RLS le apliquen siempre.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'signage_app') THEN
    CREATE ROLE signage_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Contexto de seguridad de la request (lo fija withTx con SET LOCAL). Sin valor => NULL =>
-- ninguna fila coincide. Un valor que no es uuid lanza: falla cerrado.
CREATE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
CREATE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Planes: dato global de solo lectura para la aplicación.
CREATE TABLE plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,
  max_devices       int    NOT NULL CHECK (max_devices >= 0),
  max_users         int    NOT NULL CHECK (max_users >= 0),
  max_storage_bytes bigint NOT NULL CHECK (max_storage_bytes >= 0),
  max_media_bytes   bigint NOT NULL CHECK (max_media_bytes >= 0),
  features          jsonb  NOT NULL DEFAULT '{}'
);
-- Valores de partida (spec §7, a confirmar).
INSERT INTO plans (code, max_devices, max_users, max_storage_bytes, max_media_bytes)
VALUES ('free', 2, 2, 1073741824, 104857600);

-- Usuarios: globales (una persona puede pertenecer a varias empresas), sin RLS. Solo el
-- módulo de auth los toca; nada de lo que cuelga de una empresa se lee desde aquí.
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  password_hash     text NOT NULL,
  email_verified_at timestamptz,
  name              text NOT NULL,
  locale            text NOT NULL DEFAULT 'es',
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  plan_id    uuid NOT NULL REFERENCES plans (id),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- Las claves foráneas hacia otra tabla con tenant son COMPUESTAS (organization_id, id):
-- una fila de la empresa A no puede apuntar a una ubicación de la empresa B ni aunque la
-- aplicación se equivoque.
CREATE TABLE locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  parent_id       uuid,
  name            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'UTC',
  address         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, parent_id) REFERENCES locations (organization_id, id),
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE INDEX locations_org_idx ON locations (organization_id);

CREATE TABLE devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  location_id     uuid,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_ip         text,
  last_user_agent text,
  app_version     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id)
);
CREATE INDEX devices_org_idx ON devices (organization_id);

-- RLS: ENABLE + FORCE (FORCE aplica también al dueño de la tabla).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY; ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships   ENABLE ROW LEVEL SECURITY; ALTER TABLE memberships   FORCE ROW LEVEL SECURITY;
ALTER TABLE locations     ENABLE ROW LEVEL SECURITY; ALTER TABLE locations     FORCE ROW LEVEL SECURITY;
ALTER TABLE devices       ENABLE ROW LEVEL SECURITY; ALTER TABLE devices       FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant ON organizations USING (id = app_org()) WITH CHECK (id = app_org());
-- Para listar «mis empresas» antes de elegir una: solo lectura, por membresía propia.
CREATE POLICY own_orgs ON organizations FOR SELECT
  USING (id IN (SELECT organization_id FROM memberships WHERE user_id = app_user()));

CREATE POLICY tenant ON memberships USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
CREATE POLICY own ON memberships FOR SELECT USING (user_id = app_user());

CREATE POLICY tenant ON locations USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
CREATE POLICY tenant ON devices   USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());

-- Privilegios mínimos para la aplicación.
GRANT USAGE ON SCHEMA public TO signage_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, organizations, memberships, locations, devices TO signage_app;
GRANT SELECT ON plans TO signage_app;
GRANT EXECUTE ON FUNCTION app_org(), app_user() TO signage_app;
