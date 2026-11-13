// Operaciones puras sobre los archivos de un proyecto: `.env`, `.nvmrc` y
// `.flockrc`. Se prueban aisladas para que el proceso principal no dependa del
// formato exacto que deja cada versión de Laravel.

import { patchEnv } from './laravel'
import type { SiteFramework } from './site'

/** Claves cuyo valor no debe viajar nunca a la interfaz. */
const SECRET_KEY = /(PASSWORD|SECRET|PRIVATE|_KEY|TOKEN|CREDENTIALS|SALT)/i

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key)
}

export interface ParsedEnv {
  key: string
  value: string
  secret: boolean
}

/**
 * Lee un `.env` línea a línea. Respeta comentarios y valores entre comillas.
 * Las líneas que no son `CLAVE=valor` se ignoran, igual que hace Laravel.
 */
export function parseEnv(text: string): ParsedEnv[] {
  const out: ParsedEnv[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out.push({ key, value, secret: isSecretKey(key) })
  }
  return out
}

export function envValue(entries: ParsedEnv[], key: string): string {
  return entries.find((e) => e.key === key)?.value ?? ''
}

/** Aplica cambios a un `.env`. `null` elimina la clave; `''` la deja vacía. */
export function applyEnvChanges(text: string, changes: { key: string; value: string | null }[]): string {
  let out = text
  for (const { key, value } of changes) {
    if (value !== null) {
      out = patchEnv(out, { [key]: value })
      continue
    }
    const re = new RegExp(`^\\s*(?:#\\s*)?${escapeRe(key)}\\s*=.*(?:\\r?\\n)?`, 'm')
    out = out.replace(re, '')
  }
  return out
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Versión de Node escrita en `.nvmrc`, `.node-version` o `.flockrc`. */
export function pinnedNodeVersion(text: string): string | null {
  const raw = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  if (!raw) return null
  const value = raw.replace(/^node=/, '').replace(/^v/, '').trim()
  return /^\d+(?:\.\d+){0,2}$/.test(value) ? value : null
}

/** Versión de PHP escrita en `.flockrc` (`php=8.5`, admite comentario al final). */
export function pinnedPhpVersion(text: string): string | null {
  const m = text.match(/^\s*php\s*=\s*"?(\d+\.\d+)"?\s*(?:#.*)?$/m)
  return m ? m[1] : null
}

/** `22.11.0` → `22`. Cualquier otra cosa devuelve la cadena vacía. */
export function majorVersion(version: string): string {
  const m = version.trim().replace(/^v/, '').match(/^(\d+)(?:\.\d+){0,2}$/)
  return m ? m[1] : ''
}

/** Compara dos versiones numéricas (`8.10` > `8.9`). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Clasifica el proyecto con lo que hay en su raíz. */
export function pickFramework(files: {
  artisan: boolean
  composerJson: boolean
  composerLock: boolean
  indexPhp: boolean
  publicIndexPhp: boolean
}): SiteFramework {
  if (files.artisan) return 'laravel'
  if (files.indexPhp || files.publicIndexPhp || files.composerJson || files.composerLock) return 'php'
  return 'static'
}

/** Nombre del sitio a partir del archivo de nginx aislado (`site.test` o `site.test.conf`). */
export function isolatedSiteName(file: string, domain: string): string | null {
  const base = file.endsWith('.conf') ? file.slice(0, -5) : file
  const suffix = `.${domain}`
  if (!base.endsWith(suffix)) return null
  return base.slice(0, -suffix.length) || null
}

/** Comentario que escribe Valet al aislar un sitio: `# ISOLATED_PHP_VERSION=8.4`. */
export function isolatedPhpVersion(nginxConfig: string): string | null {
  const m = nginxConfig.match(/^#\s*ISOLATED_PHP_VERSION\s*=\s*(\d+\.\d+)\s*$/m)
  return m ? m[1] : null
}

/** Nombre de bandeja del catcher: minúsculas y sin caracteres raros. */
export function inboxName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

/** Par coherente de `MAIL_SCHEME` y `MAIL_ENCRYPTION` para la interfaz. */
export function mailSchemePair(encryption: string): { scheme: string; encryption: string } {
  switch (encryption.trim().toLowerCase()) {
    case 'tls':
      return { scheme: 'smtp', encryption: 'tls' }
    case 'ssl':
      return { scheme: 'smtps', encryption: 'ssl' }
    default:
      return { scheme: 'null', encryption: 'null' }
  }
}

/**
 * Encriptación efectiva leída del `.env`. Laravel 11 usa `MAIL_SCHEME`
 * (`smtp`/`smtps`) y Laravel 10 usa `MAIL_ENCRYPTION` (`tls`/`ssl`). Los
 * valores `null` significan "sin cifrado", no la cadena "null".
 */
export function mailEncryptionOf(entries: ParsedEnv[]): string {
  const clean = (value: string): string => {
    const normalized = value.trim().toLowerCase()
    return normalized === 'null' || normalized === 'none' ? '' : normalized
  }
  const scheme = clean(envValue(entries, 'MAIL_SCHEME'))
  const legacy = clean(envValue(entries, 'MAIL_ENCRYPTION'))
  if (scheme === 'smtps') return 'ssl'
  if (scheme === 'smtp') return legacy === 'ssl' ? 'ssl' : legacy === 'tls' ? 'tls' : ''
  if (scheme) return scheme
  return legacy === 'ssl' ? 'ssl' : legacy === 'tls' ? 'tls' : ''
}

/** Valor de `.env` con comillas solo cuando hace falta. */
export function envFileValue(value: string): string {
  return /[\s#"'`]/.test(value)
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : value
}

/**
 * Bloque que un proyecto Laravel necesita para enviar el correo al catcher.
 * La contraseña va como `null` porque acepta cualquier credencial; el usuario
 * SMTP elige la bandeja.
 */
export function mailEnvBlock(mail: {
  mailer: string
  host: string
  port: number
  username: string
  encryption: string
}): string {
  const pair = mailSchemePair(mail.encryption)
  const lines = [
    `MAIL_MAILER=${envFileValue(mail.mailer)}`,
    `MAIL_HOST=${envFileValue(mail.host)}`,
    `MAIL_PORT=${mail.port}`,
    `MAIL_USERNAME=${envFileValue(mail.username)}`,
    `MAIL_PASSWORD=null`,
    `MAIL_SCHEME=${pair.scheme}`,
    `MAIL_ENCRYPTION=${pair.encryption}`
  ]
  return lines.join('\n')
}
