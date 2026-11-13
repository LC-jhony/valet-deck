// Preparación de MariaDB sin abrir una terminal.
//
// `mariadb-secure-installation` es interactivo y destructivo: quitar usuarios
// anónimos, borrar la base `test` o cambiar `root` son decisiones de la
// persona. Este módulo solo hace el subconjunto que los proyectos necesitan:
// crear o comprobar el usuario gestionado `valet_studio` y guardar sus
// credenciales. El secure se abre a mano desde la ficha de seguridad.
//
// La contraseña se genera aquí, se pasa por la entrada estándar (nunca por
// argv) y se guarda en `~/.valet-studio/mariadb.json` con permisos 0600.

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MariaDbCredentials } from '../shared/types'
import { APP_DIR, env, run, runWithEnv } from './exec'
import { elevated, elevatedInput } from './elevate'

export const MARIADB_USER = 'valet_studio'
export const MARIADB_HOST = '127.0.0.1'
export const MARIADB_PORT = 3306
export const MARIADB_CREDENTIALS_FILE = join(APP_DIR, 'mariadb.json')
export const MARIADB_DATA_DIR = '/var/lib/mysql'
/**
 * Marca de procedencia: solo existe si el panel instaló MariaDB. El postrm la
 * consulta para no parar ni purgar una instalación que ya estaba en el equipo.
 */
export const MARIADB_INSTALLED_MARKER = '/var/lib/valet-studio/mariadb'

const PASSWORD_RE = /^[A-Za-z0-9_-]{24,128}$/

/** Contraseña aleatoria apta para SQL y para una URL de conexión. */
export function generateMariaDbPassword(): string {
  return randomBytes(24).toString('base64url')
}

/** Valida lo leído del disco antes de usarlo o enseñarlo en la interfaz. */
export function parseMariaDbCredentials(raw: string | null | undefined): MariaDbCredentials | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<MariaDbCredentials>
    if (
      typeof value.host !== 'string' || value.host.trim() === '' ||
      typeof value.username !== 'string' || value.username.trim() === '' ||
      typeof value.password !== 'string' || value.password === '' ||
      typeof value.port !== 'number' || !Number.isInteger(value.port) ||
      value.port < 1 || value.port > 65535
    ) return null
    return {
      host: value.host,
      port: value.port,
      username: value.username,
      password: value.password
    }
  } catch {
    return null
  }
}

/**
 * SQL idempotente y no destructivo. La contraseña llega ya generada y se
 * comprueba contra un alfabeto cerrado: nunca se interpola texto libre en la
 * sentencia. No toca `root`, ni los usuarios anónimos, ni la base `test`.
 */
export function buildMariaDbPrepareSql(password: string): string {
  if (!PASSWORD_RE.test(password)) throw new Error('Invalid generated MariaDB password')
  const users = [`'${MARIADB_USER}'@'localhost'`, `'${MARIADB_USER}'@'127.0.0.1'`]
  const lines: string[] = []
  for (const user of users) {
    lines.push(`CREATE USER IF NOT EXISTS ${user} IDENTIFIED BY '${password}';`)
    // Si el usuario ya existía con otra contraseña, se restaura la guardada.
    // Nunca se inventa una nueva: los proyectos anteriores dejarían de conectar.
    lines.push(`ALTER USER ${user} IDENTIFIED BY '${password}';`)
    lines.push(`GRANT ALL PRIVILEGES ON *.* TO ${user};`)
  }
  lines.push('FLUSH PRIVILEGES;')
  // El resultado se lee de la salida estándar para avisar si MariaDB escucha
  // fuera de loopback. Así no hace falta una segunda elevación.
  lines.push('SELECT @@bind_address;')
  return lines.join('\n')
}

export interface MariaDbCredentialsPlan {
  credentials: MariaDbCredentials
  /** `true` solo cuando no había credenciales guardadas. */
  generated: boolean
}

/**
 * Decide qué contraseña usar. La guardada siempre se conserva: rotarla sin
 * permiso rompería los proyectos que ya están conectados. Solo se genera una
 * nueva en la primera instalación.
 */
export function planMariaDbCredentials(existing: MariaDbCredentials | null): MariaDbCredentialsPlan {
  return {
    generated: existing === null,
    credentials: {
      host: MARIADB_HOST,
      port: MARIADB_PORT,
      username: MARIADB_USER,
      password: existing?.password ?? generateMariaDbPassword()
    }
  }
}

export interface MariaDbProbe {
  /** `mariadbd` (o el servidor MariaDB) ya está instalado. */
  mariadbServer: boolean
  /** Hay un servidor MySQL ajeno (`mysqld`). */
  mysqlServer: boolean
  /** `/var/lib/mysql` tiene el esquema del sistema, no está vacío. */
  dataDirInitialized: boolean
}

/**
 * Motivo para no instalar MariaDB encima de otra instalación. Devolver `null`
 * significa que el instalador puede seguir. `mariadb-server` reemplaza a
 * `mysql-server` en Debian/Ubuntu y `mariadb` entra en conflicto con `mysql` en
 * Arch: pisar esos datos sin preguntar es irreversible.
 */
export function foreignMariaDbReason(probe: MariaDbProbe): string | null {
  if (probe.mariadbServer) return null
  if (probe.mysqlServer) {
    return 'An existing MySQL server was found. Valet Deck will not replace it with MariaDB automatically: finish or remove that installation first.'
  }
  if (probe.dataDirInitialized) {
    return `An existing database directory was found at ${MARIADB_DATA_DIR}. Valet Deck will not install MariaDB over it: back it up or finish its setup first.`
  }
  return null
}

/** AVISO cuando MariaDB escucha en todas las interfaces. */
export function bindAddressWarning(address: string | null | undefined): string | null {
  const value = (address ?? '').trim()
  if (value !== '0.0.0.0' && value !== '::' && value !== '*') return null
  return `MariaDB is listening on ${value}; other machines may reach it. Set bind-address = 127.0.0.1 in the MariaDB configuration.`
}

/** Última línea de la salida del SQL: `SELECT @@bind_address`. */
export function parseBindAddress(output: string): string | null {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : null
}

/** Mensaje accionable según lo que contestó el servidor al abrir el socket. */
export function mariaDbRootError(detail: string): string {
  const suffix = detail ? ` (${detail})` : ''
  if (/access denied/i.test(detail)) {
    return `MariaDB is running, but root no longer accepts the local socket login. If you set a root password, the panel cannot use it automatically: check the account with \`sudo mariadb\` or create the valet_studio user by hand. The secure installation remains manual.${suffix}`
  }
  if (/can't connect|connection refused|no such file|unknown socket/i.test(detail)) {
    return `Could not connect to MariaDB over the local socket. Start the MariaDB service and try again.${suffix}`
  }
  return `MariaDB refused to prepare the managed valet_studio user. Check the server with \`sudo mariadb\`; the secure installation remains manual.${suffix}`
}

/** Lee las credenciales guardadas; `null` si no existen o están mal formadas. */
export async function readMariaDbCredentials(): Promise<MariaDbCredentials | null> {
  return parseMariaDbCredentials(await readFile(MARIADB_CREDENTIALS_FILE, 'utf8').catch(() => null))
}

/**
 * Escritura atómica: se escribe en un archivo temporal del mismo directorio y se
 * renombra. Si el proceso muere a medias, el archivo anterior sigue intacto en
 * lugar de quedar un JSON truncado que obligaría a rotar la contraseña (y
 * rompería el `.env` de los proyectos ya creados).
 */
export async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tmp, content, { mode })
    await chmod(tmp, mode)
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

async function saveMariaDbCredentials(credentials: MariaDbCredentials): Promise<void> {
  await mkdir(APP_DIR, { recursive: true, mode: 0o700 })
  await writeFileAtomic(MARIADB_CREDENTIALS_FILE, `${JSON.stringify(credentials, null, 2)}\n`, 0o600)
}

/** Socket por defecto de MariaDB en Debian y Ubuntu. */
export const MARIADB_SOCKET = '/run/mysqld/mysqld.sock'

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface RetryOptions {
  attempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** Repite `probe` hasta que devuelva `true` o se agoten los intentos. */
export async function waitUntil(probe: () => Promise<boolean>, options: RetryOptions = {}): Promise<boolean> {
  const { attempts = 20, delayMs = 1000, sleep = defaultSleep } = options
  for (let i = 0; i < attempts; i++) {
    if (await probe().catch(() => false)) return true
    if (i < attempts - 1) await sleep(delayMs)
  }
  return false
}

/** Errores que desaparecen solos poco después de arrancar el servicio. */
export function isTransientMariaDbError(message: string): boolean {
  return /can't connect|connection refused|no such file|unknown socket|server has gone away|lost connection/i.test(message)
}

/** Ejecuta `fn`, repitiéndola solo mientras el error sea transitorio. */
export async function retryTransient<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, delayMs = 2000, sleep = defaultSleep } = options
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (!isTransientMariaDbError((e as Error).message) || i === attempts - 1) throw e
      await sleep(delayMs)
    }
  }
  throw last
}

/**
 * Espera a que el servicio esté activo y el socket exista. `systemctl enable
 * --now` vuelve en cuanto systemd lanza el proceso, no cuando MariaDB acepta
 * conexiones: sin esta espera, el primer `CREATE USER` puede fallar de forma
 * intermitente en equipos lentos o al recuperar tras un apagado sucio.
 */
export async function waitForMariaDb(options: RetryOptions = {}): Promise<boolean> {
  return waitUntil(async () => {
    const active = (await run('systemctl', ['is-active', 'mariadb'], true)).trim() === 'active'
    return active && existsSync(MARIADB_SOCKET)
  }, options)
}

/** Clientes que pueden hablar con MariaDB; `mysql` cubre instalaciones antiguas. */
export const MARIADB_CLIENTS = ['mariadb', 'mysql'] as const

/** Primer cliente disponible; `null` si no hay ninguno en el PATH. */
export async function findMariaDbClient(): Promise<string | null> {
  for (const client of MARIADB_CLIENTS) {
    const path = (await run('which', [client], true)).trim()
    if (path !== '') return path
  }
  return null
}

/** ¿La contraseña guardada sigue sirviendo? Se prueba por TCP, como PHP. */
export async function testMariaDbCredentials(credentials: MariaDbCredentials): Promise<boolean> {
  const client = await findMariaDbClient()
  if (!client) return false
  try {
    const out = await runWithEnv(
      client,
      [
        '--protocol=tcp', `-h${credentials.host}`, `-P${credentials.port}`,
        `-u${credentials.username}`, '--batch', '--skip-column-names', '-e', 'SELECT 1'
      ],
      { ...env, MYSQL_PWD: credentials.password },
      true
    )
    return out.trim() === '1'
  } catch {
    return false
  }
}

/**
 * Prepara el usuario gestionado y devuelve credenciales utilizables. Repetir
 * la operación conserva la contraseña: los proyectos creados antes no pierden
 * la conexión. No borra usuarios anónimos, ni `test`, ni toca `root`.
 */
export async function prepareMariaDb(log: (text: string) => void = () => {}): Promise<MariaDbCredentials> {
  const bin = await findMariaDbClient()
  if (!bin) throw new Error('The MariaDB client is missing: install mariadb-client or mysql-client.')
  const existing = await readMariaDbCredentials()
  const { credentials, generated } = planMariaDbCredentials(existing)

  log(generated
    ? 'Preparing MariaDB: creating the managed valet_studio user…\n'
    : 'Preparing MariaDB: checking the managed valet_studio user…\n')

  if (!(await waitForMariaDb())) {
    log('MariaDB did not report ready within 20 s; trying anyway…\n')
  }

  let output = ''
  try {
    output = await retryTransient(() => elevatedInput(
      bin, ['--protocol=socket', '--batch', '--skip-column-names'], buildMariaDbPrepareSql(credentials.password)
    ))
  } catch (e) {
    throw new Error(mariaDbRootError((e as Error).message))
  }

  // Se guarda después de que el SQL haya funcionado, pero antes de la prueba
  // TCP: el servidor ya tiene esa contraseña y hay que poder reutilizarla.
  await saveMariaDbCredentials(credentials)

  const warning = bindAddressWarning(parseBindAddress(output))
  if (warning) log(`Warning: ${warning}\n`)

  if (!(await waitUntil(() => testMariaDbCredentials(credentials), { attempts: 5 }))) {
    throw new Error(
      generated
        ? 'MariaDB accepted the managed valet_studio user, but it cannot connect over TCP. Check the server bind address and port 3306.'
        : 'The saved valet_studio password no longer works and was not rotated automatically. Check ~/.valet-studio/mariadb.json and the MariaDB user by hand.'
    )
  }
  log(`MariaDB ready: ${MARIADB_USER}@${MARIADB_HOST}:${MARIADB_PORT} (password in ${MARIADB_CREDENTIALS_FILE}, mode 0600).\n`)
  return credentials
}

/**
 * Deja constancia de que MariaDB lo instaló el panel. Si falla, la instalación
 * sigue: el peor caso es que la desinstalación no purgue MariaDB.
 */
export async function markMariaDbInstalled(): Promise<void> {
  await elevated('install', ['-D', '-m', '0644', '/dev/null', MARIADB_INSTALLED_MARKER])
}
