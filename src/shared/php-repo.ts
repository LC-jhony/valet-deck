// Qué repositorio de PHP toca usar en cada sistema, decidido sin tocar nada.
//
// El panel instala PHP con apt. Históricamente eso significaba el PPA de
// Ondřej, pero el PPA solo publica paquetes para las LTS con soporte estándar
// (jammy, noble): en una versión intermedia reciente —p. ej. Ubuntu 25.10— el
// PPA acaba en un 404 y se usa el repositorio de Sury (packages.sury.org).
// Desde Ubuntu 26.04 la distribución ya trae PHP 8.5: se usa su paquete y no se
// mezcla con Sury, cuyas dependencias son las de 26.04 (libsodium23) y no las
// de 26.10 (libsodium26). En EOL se usa el PHP de la distribución.

export type PhpRepoKind = 'ppa' | 'sury'

/** Lo que la interfaz necesita saber del repositorio PHP de esta máquina. */
export interface PhpRepoState {
  kind: PhpRepoKind | null
  suite: string | null
  label: string
  /** Por qué se eligió este repositorio (o por qué no hay ninguno). */
  note: string | null
  /** Comandos equivalentes a mano. */
  commands: string[]
  /** El repositorio ya figura en los orígenes de apt. */
  enabled: boolean
  /**
   * Hay un origen de Sury configurado que esta Ubuntu ya no puede usar y que
   * el panel retirará (con copia de seguridad) en la próxima instalación.
   */
  stale: boolean
}

/** Datos mínimos de /etc/os-release que la decisión necesita. */
export interface RepoOsInfo {
  ubuntu: boolean
  support: 'supported' | 'eol' | 'unknown'
  codename: string
  versionId: string
}

/** Series de Ubuntu que el PPA de Ondřej publica de verdad. */
export const PPA_SERIES: ReadonlySet<string> = new Set(['jammy', 'noble'])

/** Suites de Ubuntu presentes en packages.sury.org/php/dists. */
export const SURY_SERIES: ReadonlySet<string> = new Set(['jammy', 'noble', 'resolute'])

/** Suite de Sury más nueva publicada; la usan las versiones sin suite propia. */
export const SURY_NEWEST_SUITE = 'resolute'

export const SURY_URL = 'https://packages.sury.org/php'
export const SURY_KEYRING = '/usr/share/keyrings/sury-php.gpg'
export const SURY_LIST = '/etc/apt/sources.list.d/sury-php.list'

/**
 * Versión de Ubuntu desde la que el PHP de la distribución ya cubre el
 * objetivo del panel. Ubuntu 26.04 y 26.10 traen PHP 8.5 y `libsodium26`;
 * mezclarlos con paquetes de Sury para 26.04 exige `libsodium23`, que esa
 * versión ya no publica. A partir de aquí manda la distribución.
 */
export const DISTRO_TARGET_PHP_SERIES = '26.04'

/** ¿La versión de Ubuntu ya trae el PHP objetivo en sus propios repositorios? */
export function distroProvidesTargetPhp(info: RepoOsInfo): boolean {
  if (!info.ubuntu || info.support === 'eol') return false
  const current = info.versionId.split('.').map((part) => Number.parseInt(part, 10))
  const minimum = DISTRO_TARGET_PHP_SERIES.split('.').map((part) => Number.parseInt(part, 10))
  if (!Number.isFinite(current[0]) || !Number.isFinite(current[1])) return false
  return current[0] > minimum[0] || (current[0] === minimum[0] && current[1] >= minimum[1])
}

/**
 * Suite de Sury para esta versión de Ubuntu, o `null` si no hay ninguna
 * razonable. Las versiones intermedias más nuevas que la última suite
 * publicada (p. ej. 25.10) usan la suite más nueva: Sury la mantiene al día y
 * sus dependencias cubren las de la versión intermedia. Desde 26.04 no se usa:
 * la distribución ya trae el PHP objetivo.
 */
export function surySuite(info: RepoOsInfo): string | null {
  if (!info.ubuntu || info.support === 'eol') return null
  if (distroProvidesTargetPhp(info)) return null
  if (info.codename && SURY_SERIES.has(info.codename)) return info.codename
  const major = Number.parseInt(info.versionId, 10)
  if (Number.isFinite(major) && major >= 25) return SURY_NEWEST_SUITE
  return null
}

/** Repositorio que instala el PHP gestionado en este sistema. */
export function phpRepoFor(info: RepoOsInfo): { kind: PhpRepoKind | null; suite: string | null } {
  if (!info.ubuntu || info.support === 'eol') return { kind: null, suite: null }
  if (distroProvidesTargetPhp(info)) return { kind: null, suite: null }
  // Sin codename no se puede saber qué suite tocaría: se conserva el
  // comportamiento histórico (intentar el PPA) en vez de inventar uno.
  if (!info.codename) return { kind: 'ppa', suite: null }
  if (PPA_SERIES.has(info.codename)) return { kind: 'ppa', suite: info.codename }
  const suite = surySuite(info)
  if (suite) return { kind: 'sury', suite }
  return { kind: null, suite: null }
}

/** Etiqueta corta para la interfaz. */
export function phpRepoLabel(kind: PhpRepoKind | null, suite: string | null): string {
  if (kind === 'ppa') return 'Ondřej PPA'
  if (kind === 'sury') return `Sury · suite ${suite ?? '—'}`
  return 'Distribution PHP'
}

/** Línea exacta que queda escrita en `/etc/apt/sources.list.d/sury-php.list`. */
export function surySourceLine(suite: string): string {
  return `deb [signed-by=${SURY_KEYRING}] ${SURY_URL}/ ${suite} main`
}

/** Comandos equivalentes a mano para el PPA de Ondřej. */
export function ppaRepoCommands(): string[] {
  return [
    'sudo add-apt-repository -y ppa:ondrej/php',
    'sudo apt-get update'
  ]
}

/** Comandos equivalentes a mano para el repositorio de Sury. */
export function suryRepoCommands(suite: string): string[] {
  return [
    'sudo apt-get install -y curl ca-certificates',
    `sudo curl -fsSL ${SURY_URL}/apt.gpg -o ${SURY_KEYRING}`,
    `echo '${surySourceLine(suite)}' | sudo tee ${SURY_LIST}`,
    'sudo apt-get update'
  ]
}

/**
 * Guion bash que instala la clave de Sury y escribe su lista de apt. Es puro
 * (devuelve texto) para poder probarlo sin tocar el sistema; el llamador lo
 * ejecuta elevado con `bash -c`. La suite se valida: va interpolada en el
 * guion y nunca debe poder romper las comillas.
 */
export function suryInstallSnippet(suite: string): string {
  if (!/^[a-z0-9]+$/.test(suite)) throw new Error('Invalid Sury suite')
  return [
    'set -Eeo pipefail',
    'install -d -m 0755 /usr/share/keyrings',
    `if command -v curl >/dev/null 2>&1; then`,
    `  curl -fsSL '${SURY_URL}/apt.gpg' -o '${SURY_KEYRING}'`,
    `elif command -v wget >/dev/null 2>&1; then`,
    `  wget -qO '${SURY_KEYRING}' '${SURY_URL}/apt.gpg'`,
    `else`,
    `  echo 'curl or wget is required to download the Sury signing key' >&2`,
    `  exit 1`,
    `fi`,
    `chmod 0644 '${SURY_KEYRING}'`,
    `printf '%s\\n' '${surySourceLine(suite)}' > '${SURY_LIST}'`,
    `echo "Added ${SURY_LIST} (Sury PHP, suite ${suite})"`
  ].join('\n')
}

/** Comandos equivalentes a mano para el repositorio decidido. */
export function phpRepoCommands(kind: PhpRepoKind | null, suite: string | null): string[] {
  if (kind === 'ppa') return ppaRepoCommands()
  if (kind === 'sury' && suite) return suryRepoCommands(suite)
  return []
}
