// Detección de la distribución: versión, estado de soporte y consecuencias para
// el instalador. Todo es puro (recibe el texto de /etc/os-release y la fecha)
// para poder probarlo sin tocar el sistema.
//
// Por qué existe: el instalador asumía «Ubuntu = PHP 8.5 desde el PPA de Ondrej».
// En una versión sin soporte (p. ej. 20.10 «groovy», EOL desde julio de 2021)
// eso falla dos veces: los repositorios se archivaron en old-releases.ubuntu.com
// y el PPA de Ondrej borra los paquetes de las versiones terminadas. En las
// versiones intermedias anteriores a 26.04 (p. ej. 25.10) el PPA tampoco
// existe: ahí se usa el repositorio de Sury (ver shared/php-repo.ts). Desde
// 26.04 manda el PHP de la distribución.

import { distroProvidesTargetPhp, phpRepoFor, PPA_SERIES } from '../shared/php-repo'

export interface OsRelease {
  id: string
  idLike: string
  /** `VERSION_ID`, p. ej. `20.10`. Vacío si no consta. */
  versionId: string
  /** `VERSION_CODENAME` (o `UBUNTU_CODENAME`), p. ej. `groovy`. */
  codename: string
  prettyName: string
}

export type SupportState = 'supported' | 'eol' | 'unknown'

export interface PlatformInfo extends OsRelease {
  /** Es Ubuntu o una derivada que se identifica como tal. */
  ubuntu: boolean
  support: SupportState
  /** Fecha (ISO) de fin de soporte estándar cuando se conoce. */
  eolDate: string | null
}

/**
 * Series de Ubuntu cuyo soporte estándar ya terminó, con su fecha de fin.
 * Solo se listan las que consta que terminaron; una versión que no está aquí se
 * trata como «soportada o desconocida» y nunca se bloquea por esta tabla.
 */
export const UBUNTU_EOL: Readonly<Record<string, string>> = {
  xenial: '2021-04-30',
  bionic: '2023-05-31',
  eoan: '2020-07-17',
  focal: '2025-05-31',
  groovy: '2021-07-22',
  hirsute: '2022-01-20',
  impish: '2022-07-14',
  kinetic: '2023-07-20',
  lunar: '2024-01-25',
  mantic: '2024-07-11',
  oracular: '2025-07-10'
}

export { PPA_SERIES } from '../shared/php-repo'

function field(text: string, key: string): string {
  const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'))
  return (match?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
}

export function parseOsRelease(text: string): OsRelease {
  const codename = field(text, 'VERSION_CODENAME') || field(text, 'UBUNTU_CODENAME')
  return {
    id: field(text, 'ID').toLowerCase(),
    idLike: field(text, 'ID_LIKE').toLowerCase(),
    versionId: field(text, 'VERSION_ID'),
    codename: codename.toLowerCase(),
    prettyName: field(text, 'PRETTY_NAME') || field(text, 'NAME') || field(text, 'ID') || 'unknown'
  }
}

export function detectPlatform(text: string, now: Date = new Date()): PlatformInfo {
  const os = parseOsRelease(text)
  const ubuntu = /\bubuntu\b/.test(`${os.id} ${os.idLike}`)
  let support: SupportState = 'unknown'
  let eolDate: string | null = null
  if (ubuntu && os.codename) {
    eolDate = UBUNTU_EOL[os.codename] ?? null
    if (eolDate) support = new Date(`${eolDate}T23:59:59Z`).getTime() < now.getTime() ? 'eol' : 'supported'
    else support = 'supported'
  }
  return { ...os, ubuntu, support, eolDate }
}

/** ¿El PPA de Ondrej tiene paquetes para esta versión de Ubuntu? */
export function ppaAvailable(info: PlatformInfo): boolean {
  if (!info.ubuntu || info.support === 'eol') return false
  // Sin codename no se puede saber: se conserva el comportamiento anterior.
  return info.codename === '' || PPA_SERIES.has(info.codename)
}

export interface PhpPlan {
  /** Versión fija que el panel instala, o `null` para usar el PHP de la distribución. */
  version: string | null
  /** Mensaje para el registro cuando el plan no es el habitual. */
  note: string | null
  /** Repositorio del que saldrá ese PHP; `null` si es el de la distribución. */
  repository: 'ppa' | 'sury' | null
  /** Suite del repositorio (codename), p. ej. `resolute`. */
  suite: string | null
}

/**
 * Decide qué PHP instalar y de qué repositorio. El panel fija `preferred`
 * siempre que el PPA de Ondrej o el repositorio de Sury lo ofrezcan; solo usa
 * el PHP de la distribución cuando ninguna de las dos fuentes cubre la
 * versión (p. ej. una Ubuntu sin soporte).
 */
export function planPhp(info: PlatformInfo, preferred: string): PhpPlan {
  if (!info.ubuntu) return { version: null, note: null, repository: null, suite: null }
  const repo = phpRepoFor(info)
  const where = info.codename ? `Ubuntu ${info.versionId || info.codename} (${info.codename})` : 'this Ubuntu release'
  // Desde 26.04 la distribución trae el PHP del panel: se usa tal cual. Sury
  // no publica una suite para cada versión nueva y sus paquetes piden las
  // librerías de 26.04 (libsodium23), que 26.10 ya no ofrece.
  if (distroProvidesTargetPhp(info)) {
    return {
      version: null,
      note:
        `${where} already ships PHP ${preferred} in its own repositories; the panel uses it ` +
        'instead of the Ondrej PPA or Sury. Sury packages target an older Ubuntu release and ' +
        'need libraries this release no longer provides.',
      repository: null,
      suite: null
    }
  }
  if (repo.kind === 'ppa') {
    return { version: preferred, note: null, repository: 'ppa', suite: repo.suite }
  }
  if (repo.kind === 'sury') {
    const fallback = Boolean(repo.suite && info.codename && repo.suite !== info.codename)
    return {
      version: preferred,
      note: fallback
        ? `${where} has no Ondrej PPA or Sury suite of its own; PHP ${preferred} will come from the newest Sury suite (${repo.suite}).`
        : null,
      repository: 'sury',
      suite: repo.suite
    }
  }
  return {
    version: null,
    note:
      `${where} is not covered by the Ondrej PPA, so PHP ${preferred} cannot be installed here. ` +
      'The PHP offered by the distribution repositories will be used instead.',
    repository: null,
    suite: null
  }
}

/** Mensaje de aviso para una versión sin soporte; `null` si no aplica. */
export function eolWarning(info: PlatformInfo): string | null {
  if (info.support !== 'eol') return null
  const when = info.eolDate ? ` since ${info.eolDate}` : ''
  return (
    `${info.prettyName} no longer receives security updates${when}. ` +
    'It can run a local development environment, but upgrade to a supported Ubuntu LTS when you can.'
  )
}

/** Dominios del archivo principal de Ubuntu que se mueven a old-releases al terminar el soporte. */
const ARCHIVE_HOST_RE = /\b(?:[a-z]{2}\.)?archive\.ubuntu\.com\b|\bsecurity\.ubuntu\.com\b/

/** ¿Algún origen de apt apunta todavía al archivo principal? */
export function sourcesUseMainArchive(sourcesText: string): boolean {
  return sourcesText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .some((line) => ARCHIVE_HOST_RE.test(line))
}

/**
 * Guion bash para pasar los orígenes de apt a old-releases.ubuntu.com. Recibe
 * el directorio de copia como primer argumento (y, opcionalmente, la carpeta
 * de apt como segundo, solo para pruebas), copia cada archivo antes de
 * tocarlo y es idempotente. Solo debe ejecutarse tras confirmar que la versión
 * está en EOL y que la persona lo aceptó.
 */
export const OLD_RELEASES_SCRIPT = String.raw`#!/bin/bash
set -Eeo pipefail
umask 022
BACKUP="$1"
APT_DIR="$2"
[ -n "$APT_DIR" ] || APT_DIR=/etc/apt
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "root is required"
[ -n "$BACKUP" ] || fail "missing backup directory"
mkdir -p "$BACKUP/apt"
changed=0
for f in "$APT_DIR/sources.list" "$APT_DIR"/sources.list.d/*.list "$APT_DIR"/sources.list.d/*.sources; do
  [ -f "$f" ] || continue
  if grep -Eq '(^|[^a-z])(([a-z]{2}\.)?archive|security)\.ubuntu\.com' "$f"; then
    cp -a "$f" "$BACKUP/apt/$(basename "$f").bak"
    sed -i -E 's#https?://([a-z]{2}\.)?archive\.ubuntu\.com/ubuntu#http://old-releases.ubuntu.com/ubuntu#g; s#https?://security\.ubuntu\.com/ubuntu#http://old-releases.ubuntu.com/ubuntu#g' "$f"
    changed=1
    echo "Updated $f (backup in $BACKUP/apt)"
  fi
done
[ "$changed" -eq 1 ] || echo "No apt sources pointed at the main archive."
`
