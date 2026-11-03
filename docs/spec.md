# Signage SaaS — servicio independiente de cartelería digital

Fecha: 2026-11-03 · Estado: borrador para revisión

Producto nuevo, **sin relación con Kraken**: cualquier persona se registra, crea su empresa, define
ubicaciones, empareja sus pantallas y les asigna contenido. Parte del código de `services/signage`
(medios, playlists, manifiesto, latido), pero **no comparte** base, login, dispositivos ni despliegue
con Kraken. Vive en un repo propio; este documento es el punto de partida.

El backend se especifica completo. La app de Android TV se especifica solo como **contrato** (§9); su
implementación queda fuera de este spec.

## 1. Alcance

**Dentro:** registro y login de usuarios, empresas (tenants), membresías y roles, invitaciones,
ubicaciones, pairing y login de dispositivos, medios, playlists, asignaciones, manifiesto, latido y
presencia, comandos remotos, cuotas por plan, auditoría.

**Fuera (fase posterior):** cobro real (Stripe u otro; el modelo de planes y límites sí entra desde el día 1),
SSO empresarial, widgets de datos, transmisión en vivo, la implementación de la app de TV y del panel web.

## 2. Qué se reutiliza y qué cambia respecto a `services/signage`

| Hoy (Kraken) | En el SaaS |
|---|---|
| Login y permisos en `identity`, gateway con `auth_request` | Auth propio dentro del servicio (JWT propio) |
| TV emparejada por el pairing de identity | Pairing y credencial de dispositivo propios (§6) |
| `branch_id` suelto, de `catalog`/`hr` | `locations` propias, con FK |
| Sin tenant | `organization_id` en toda tabla + RLS (§4) |
| Lista blanca de webs global | Por empresa, con sandbox (§8) |
| Noticias de `news` en el manifiesto | Se elimina |
| Sin cuotas | Cuotas por plan (§7) |

Se conserva: `manifestVersion` como hash de la lista filtrada y sin URLs firmadas, subida directa a
almacenamiento con PUT firmado y confirmación, latido cada 30 s con presencia por umbral (90 s),
convención «sin fila de asignación = pantalla de espera», comandos entregados por el latido.

## 3. Arquitectura

- Un servicio `api` (Node 22, TypeScript, servidor HTTP propio como el resto del código de origen),
  Postgres 16, almacenamiento S3-compatible. Un solo despliegue; réplicas permitidas.
- **Correo transaccional** detrás de un puerto (`Mailer`): verificación, invitaciones, recuperación.
- **Presencia en tiempo real (SSE)** en memoria por réplica, como hoy; con más de una réplica se
  propaga por un bus (Redis pub/sub o LISTEN/NOTIFY). Se decide al desplegar; el panel además
  consulta por polling cada 60 s.
- Jobs (`setInterval` con bloqueo por `pg_try_advisory_lock` para que corra una sola réplica):
  presencia offline, limpieza de medios `pending`/vencidos, purga de pairings y sesiones, invitaciones vencidas.
- Dominios separados: `api.<dominio>` para usuarios y panel; `device.<dominio>` para las TVs (otro
  rate limit y otro origen, sin CORS).

## 4. Multiempresa y aislamiento

El riesgo central es que una empresa vea datos de otra. Dos barreras:

1. **Aplicación:** todo repositorio recibe `organizationId` obligatorio (parámetro, no opcional) y lo
   incluye en el `WHERE`. El `organizationId` sale de la sesión/credencial, **nunca del body ni de la URL**
   sin validarlo contra la membresía.
2. **Base de datos (RLS):** cada tabla con `organization_id` tiene `ENABLE` y `FORCE ROW LEVEL SECURITY`
   con política `organization_id = current_setting('app.org_id')::uuid`. Cada request abre una transacción
   que ejecuta `SET LOCAL app.org_id = …`. El rol de la aplicación **no** es dueño de las tablas ni
   `BYPASSRLS`; las migraciones y el job de purga global usan otro rol.

Un recurso de otra empresa responde **404**, nunca 403. Test obligatorio de aislamiento: para cada
ruta, un usuario de la empresa B no puede leer, listar, modificar ni borrar lo de A.

## 5. Modelo de datos

Todas las claves son `uuid`. Fechas `timestamptz`. `organization_id` en cada tabla salvo `users`, `plans`, `sessions`.

**Identidad**
- `users(id, email citext único, password_hash, email_verified_at, name, locale, status, created_at)`.
  `status`: `active | disabled`. Contraseña con argon2id.
- `sessions(id, user_id, refresh_hash único, user_agent, ip, expires_at, rotated_from, revoked_at)`.
  Refresh con rotación; reusar un refresh ya rotado revoca la cadena entera.
- `email_tokens(id, user_id, purpose, token_hash único, expires_at, used_at)`; `purpose`: `verify | reset | email_change`.
- `organizations(id, name, slug único, plan_id, status, created_at)`; `status`: `active | suspended`.
- `memberships(organization_id, user_id, role, created_at)` PK `(organization_id, user_id)`.
  `role`: `owner | admin | editor | viewer`. Siempre queda al menos un `owner` (la guarda va en el `DELETE`/`UPDATE`).
- `invitations(id, organization_id, email, role, token_hash único, invited_by, status, expires_at)`;
  `status`: `pending | accepted | revoked | expired`; índice único parcial `(organization_id, email) WHERE status='pending'`.
- `api_keys(id, organization_id, name, key_hash, role, last_used_at, expires_at, revoked_at)` — opcional fase 2.

**Ubicaciones y dispositivos**
- `locations(id, organization_id, parent_id null, name, timezone IANA, address null, created_at, archived_at)`.
  Jerarquía opcional (sin ciclos, validado con la cadena de padres; profundidad máx. 5).
- `devices(id, organization_id, location_id null, name, status, last_ip, last_user_agent, app_version, created_at, revoked_at)`.
  `status`: `active | revoked`. Un dispositivo sin ubicación es válido (recibe pantalla de espera).
- `device_pairings(id, code_hash único, secret_hash, user_agent, ip, created_at, expires_at, claimed_at, device_id null, failed_attempts)`.
- `device_tokens(id, device_id, refresh_hash único, issued_at, expires_at, revoked_at)`.

**Contenido** (de `services/signage`, con tenant)
- `categories(id, organization_id, name, status)` único `(organization_id, lower(name))`.
- `media(id, organization_id, type video|image|pdf|web, title, category_id, storage_key, content_type, size_bytes, url, duration_seconds, status pending|ready|failed, expires_at, created_by)`.
- `playlists(id, organization_id, name, status)`; `playlist_items(id, playlist_id, media_id, position, duration_override)`.
- Asignación (convención de siempre: **sin fila = pantalla de espera**):
  `location_playlists(location_id PK, playlist_id)`, `device_playlists(device_id PK, playlist_id)`.
  **Precedencia:** dispositivo > ubicación > ubicación padre (la más cercana) > espera.
- `standby(id, organization_id, location_id null, media_id null, text null)` — `location_id` nulo = valor por defecto de la empresa.
- `web_allowlist(organization_id, host)` PK compuesta.
- `device_heartbeats(device_id PK, last_seen_at, ip, local_ip, app_version, manifest_version, online)`.
- `device_commands(id, device_id, type, created_at, delivered_at)`.

**Plataforma**
- `plans(id, code, max_devices, max_users, max_storage_bytes, max_media_bytes, features jsonb)`. Plan `free` por defecto.
- `usage_counters` se **calcula** (conteos y suma de `size_bytes`), no se guarda saldo; si se vuelve caro, caché de 60 s.
- `audit_log(id, organization_id, actor_type user|device|system, actor_id, action, target_type, target_id, meta jsonb, at)` — solo agregar por trigger.

## 6. Autenticación

### 6.1 Usuarios
- `POST /v1/auth/register {email, password, name, organizationName}` crea usuario, organización (plan `free`)
  y membresía `owner` **en una transacción**; envía correo de verificación. Contraseña ≥ 10 caracteres y
  chequeo contra lista de contraseñas comunes. No revela si el correo ya existe (misma respuesta 202).
- Sin correo verificado: puede entrar pero **no** emparejar dispositivos ni subir medios (403 `email_unverified`).
- `POST /v1/auth/login` → `{accessToken (JWT 15 min), refreshToken (opaco, 30 días)}`. Bloqueo progresivo por
  correo+IP tras 5 fallos. `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `POST /v1/auth/logout-all`.
- Recuperación: `POST /v1/auth/forgot` (respuesta uniforme) y `POST /v1/auth/reset {token, password}`; reset
  revoca todas las sesiones.
- El JWT lleva `sub`; la **empresa activa** se elige por el header `X-Organization: <id>` y se valida contra
  `memberships` en cada request (un usuario puede pertenecer a varias). Rol y permisos salen de la membresía
  vigente, no del token.

### 6.2 Dispositivos (pairing)
1. La TV llama `POST /v1/device/pairing` (público, rate limit por IP). Recibe `{code (6 dígitos), pairingSecret, expiresAt}`.
   Muestra el código. Se guarda solo el hash de ambos; `code_hash` es único entre los vivos (reintento si colisiona, máx. 10 → 503).
2. Un usuario con rol `admin`+ ingresa el código en el panel: `POST /v1/devices/pairing/approve {code, name, locationId?}`.
   Crea el `device` en **su** empresa. Tras 5 intentos fallidos sobre un código, este se invalida.
   `GET /v1/devices/pairing/:code` (admin) muestra IP/UA de quien lo pidió para confirmar que es la TV correcta.
3. La TV consulta `POST /v1/device/pairing/claim {code, pairingSecret}` hasta que esté aprobado. Recibe
   `{deviceId, accessToken (JWT 1 h, claims: sub=deviceId, org, loc, typ=device), refreshToken}`. **El código no es el secreto:
   lo es `pairingSecret`**, que nunca salió de la TV.
4. Renovación: `POST /v1/device/token {refreshToken}` con rotación. **401 ⇒ la TV borra credenciales y pide un código nuevo.**
- Revocar (`DELETE /v1/devices/:id` o `POST …/revoke`) corta la sesión: borra el `device_token` y la TV recibe 401 al siguiente canje.
- Mover de ubicación (`PATCH /v1/devices/:id {locationId}`) toma efecto en el siguiente manifiesto, sin re-emparejar
  (la ubicación se lee de la base, no del token).
- Un token de persona no sirve en `/v1/device/*` ni al revés (`typ`).

## 7. Roles, permisos y cuotas

| Acción | owner | admin | editor | viewer |
|---|:-:|:-:|:-:|:-:|
| Ver ubicaciones, dispositivos, medios, playlists | ✓ | ✓ | ✓ | ✓ |
| Subir/editar medios y playlists, asignar contenido | ✓ | ✓ | ✓ | |
| Emparejar/mover/revocar dispositivos; crear ubicaciones | ✓ | ✓ | | |
| Invitar y gestionar miembros (hasta rol `admin`) | ✓ | ✓ | | |
| Lista blanca de webs, standby por defecto | ✓ | ✓ | | |
| Plan, transferir propiedad, eliminar empresa | ✓ | | | |

**Cuotas** (por plan, validadas dentro de la sentencia o la transacción que crea, no antes): dispositivos activos,
usuarios (miembros + invitaciones pendientes), almacenamiento total, tamaño máximo por archivo. Excederlas responde
`402`/`409` con `code: quota_exceeded` y qué límite. Bajar de plan no borra nada: lo que excede queda en solo lectura.
El plan `free` de partida: 2 dispositivos, 2 usuarios, 1 GB, 100 MB por archivo (valores a confirmar).

## 8. Contenido y seguridad

- **Subida:** `POST /v1/media {type, title, contentType, sizeBytes, …}` valida cuota y devuelve PUT firmado
  (tipo y tamaño fijados) a `orgs/<organizationId>/media/<uuid>.<ext>`; `POST /v1/media/:id/complete` verifica tamaño y
  **cabecera real** (no el `Content-Type` del cliente) y pasa a `ready`. Los `pending` > 24 h se purgan.
  Borrar un medio borra el objeto. CORS del bucket para el origen del panel.
- **Descarga de la TV:** URLs firmadas del manifiesto (TTL 1 h), nunca públicas.
- **Web (`type: web`):** solo hosts en `web_allowlist` **de la empresa**, solo `https`, sin credenciales en la URL,
  sin IPs ni `localhost` (anti-SSRF si algún día el servidor las visita), y la TV las abre en WebView con JS acotado.
- **Rate limits:** por IP en endpoints públicos (registro, login, forgot, pairing, claim); por usuario/empresa en el resto.
- **Auditoría:** altas/bajas de miembros, cambios de rol, emparejar/revocar/mover dispositivos, borrar medios y
  cambios de plan. Solo se agrega (trigger contra UPDATE/DELETE).
- **Datos personales:** el correo y el nombre son los únicos datos de persona. Eliminar cuenta anonimiza al usuario
  y, si es el último `owner`, exige transferir o eliminar la empresa. Eliminar empresa borra objetos y filas (job asíncrono, con gracia de 7 días).

## 9. Rutas del backend

Prefijo `/v1`. Errores `{error: {code, message}}`. Listas con `limit/offset` (máx. 100).

**Auth y cuenta** — `POST /auth/register|login|refresh|logout|logout-all|forgot|reset|verify`, `GET|PATCH /me`,
`POST /me/password`, `GET /me/organizations`.

**Empresa y miembros** — `GET|PATCH /organization`, `GET /organization/usage`, `GET /members`,
`PATCH|DELETE /members/:userId`, `POST|GET /invitations`, `DELETE /invitations/:id`,
`POST /invitations/accept {token}` (acepta un usuario existente o registra uno nuevo).

**Ubicaciones** — `GET|POST /locations`, `GET|PATCH /locations/:id`, `POST /locations/:id/archive`,
`PUT /locations/:id/playlist`, `DELETE /locations/:id/playlist`, `PUT|DELETE /locations/:id/standby`.

**Dispositivos** — `GET /devices` (estado, presencia, ubicación), `GET /devices/stream` (SSE),
`GET|PATCH|DELETE /devices/:id`, `POST /devices/:id/commands {type}` (`reload | restart | identify`),
`PUT|DELETE /devices/:id/playlist`, `GET /devices/pairing/:code`, `POST /devices/pairing/approve`.

**Contenido** — `categories`, `media` (+`/complete`, `/preview`), `playlists` (+`PUT /:id/items`), `web-allowlist`,
con la misma forma que `services/signage`, ahora con tenant.

**Dispositivo (TV)** — `POST /device/pairing`, `POST /device/pairing/claim`, `POST /device/token`,
`GET /device/manifest`, `POST /device/heartbeat`.

## 10. Contrato con la app de Android TV (sin implementar)

Contrato que el servidor se compromete a mantener; la app es un cliente más.

- **Arranque sin credencial:** `POST /device/pairing` → mostrar `code` en grande + URL/QR del panel. Sondear
  `claim` cada 3 s hasta `expiresAt`; al vencer, pedir otro código.
- **Credencial:** guardar `refreshToken` cifrado (Keystore). Renovar el `accessToken` antes de que venza; ante 401 en
  `token`, borrar todo y volver a pairing.
- **Latido** `POST /device/heartbeat {appVersion, localIp, manifestVersion}` cada 30 s. Respuesta:
  `{manifestVersion, commands: [{id, type}], serverTime}`. En línea = latido de hace menos de 90 s. Los comandos se
  entregan una sola vez y se marcan `delivered_at` al responder.
- **Manifiesto** `GET /device/manifest`: `{manifestVersion, items: [{id, type, title, url, contentType, sizeBytes, durationSeconds}], standby: {…}|null, location: {name, timezone}}`. Solo se pide si cambió `manifestVersion`.
  `url` es firmada, TTL 1 h; un medio vencido ya no viene en la lista (el hash cambia solo).
- **Caché y offline:** la app descarga a disco por `id`+`sizeBytes`, reproduce desde disco y sigue con la última lista si no hay red.
- **Reproducción:** `video | image | pdf | web`. Una app que recibe un `type` desconocido lo **omite**, no falla.
- **Versionado:** el servidor acepta `appVersion` mínima configurable; si es menor responde un comando `update-required`.
- **Requisitos de plataforma (para el spec de la app):** Android TV/Google TV, minSdk a definir (≥ 24), Media3/ExoPlayer,
  arranque al encender, modo kiosco, actualización por APK firmado.

## 11. Pruebas

- Unitarias por servicio (como `services/signage`).
- **Aislamiento entre empresas** en cada ruta (§4), incluido RLS: una consulta sin `SET LOCAL app.org_id` no devuelve filas.
- Flujo de integración contra Postgres real (se omite sin `SIGNAGE_SAAS_TEST_DATABASE_URL`): registro → verificación →
  login → ubicación → pairing → claim → manifiesto → latido → revocación → 401 en la TV.
- Concurrencia: dos `approve` del mismo código, dos `accept` de la misma invitación, borrado del último `owner`,
  tope de cuotas con subidas simultáneas.

## 12. Plan de construcción

1. Esqueleto del repo, migraciones base, RLS y la prueba de aislamiento.
2. Usuarios, sesiones, empresas, membresías e invitaciones (+ `Mailer`).
3. Ubicaciones y dispositivos con pairing.
4. Medios, playlists, asignaciones y manifiesto (portando `services/signage`).
5. Latido, presencia, comandos y SSE.
6. Cuotas, auditoría, rate limits, purgas y eliminación de empresa.
7. Spec de la app de TV y del panel sobre este contrato.

## 13. Decisiones abiertas

- Valores exactos de los planes y límites de `free`.
- Proveedor de correo y de almacenamiento.
- Bus de presencia entre réplicas (Redis o `LISTEN/NOTIFY`).
- ¿Un usuario en varias empresas desde el día 1? (el diseño lo permite; el panel puede ocultarlo).
- Dominio y marca (no se fija aquí).
- Cobro: proveedor, impuestos y facturación quedan para una etapa posterior.
