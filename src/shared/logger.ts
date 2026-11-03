import pino from 'pino';

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

export function resolveLevel(value: string | undefined): string {
  return value && LEVELS.includes(value) ? value : 'info';
}

// Regla, no configuración: el cuerpo de un request nunca se loguea. Estas rutas cubren
// lo que pudiera colarse dentro de otros objetos.
export const REDACT_PATHS = [
  'password', 'token', 'secret', 'refreshToken', 'accessToken', 'pairingSecret',
  'req.headers.authorization',
  '*.password', '*.token', '*.secret', '*.refreshToken', '*.accessToken', '*.pairingSecret',
];

const IS_TEST = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

export const logger = pino({
  level: IS_TEST ? 'silent' : resolveLevel(process.env.LOG_LEVEL),
  base: { service: 'signage-saas' },
  redact: { paths: REDACT_PATHS, censor: '[redactado]' },
});
