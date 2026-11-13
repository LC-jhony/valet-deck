import { homedir, tmpdir } from 'node:os'
import { join, basename, isAbsolute, resolve, sep } from 'node:path'
import { constants as fsConstants, existsSync } from 'node:fs'
import { access, mkdir, readFile, readdir, writeFile, copyFile, stat, realpath, rm } from 'node:fs/promises'
import type {
  ApacheInfo, CreateProjectEvent, CreateProjectOptions, PhpInfo, PortsInfo, PortUsage,
  ProjectInfo, Service, ServiceAction, Site
} from '../shared/types'
import { run } from './exec'
import { sudo } from './elevate'
import { prepareHelpers, runValet } from './helpers'
import { PROJECT_NAME_RE, patchEnv, projectEnvValues, validateAnswers, validateDatabase, type DatabaseConnection, type LaravelAnswers } from '../shared/laravel'
import { cancelLaravelNew, detectLaravel, ensureLaravel, laravelCapabilities, runLaravelNew } from './laravel-installer'
import { readMariaDbCredentials } from './mariadb-setup'
import { detectPlatform, planPhp } from './platform'
import { ensureProjectDatabase } from './database-setup'
import { PHP_VERSION } from '../shared/stack'

const HOME = homedir()
const VALET = join(HOME, '.valet')
const LINKS_DIR = join(VALET, 'Sites')
const APP = join(HOME, '.valet-studio')
const expandHome = (p: string) => (p === '~' ? HOME : p.startsWith('~/') ? join(HOME, p.slice(2)) : p)
const NGINX_SYSTEM = '/etc/nginx/sites-available/valet.conf'
const APACHE_DIR = '/etc/apache2'
const APACHE_PORTS = join(APACHE_DIR, 'ports.conf')
const APACHE_SITES = join(APACHE_DIR, 'sites-enabled')

interface AppConfig {
  http: number
  https: number
  apache?: { http: number; https: number }
}
interface Changed { file: string; backup: string; root: boolean }

/** Los nombres llegan como argumento de execFile (sin shell): solo evitamos opciones y rutas. */
const assertName = (n: string) => {
  if (typeof n !== 'string' || !n || n.trim() !== n || n === '.' || n === '..' ||
    n.startsWith('-') || /[/\\\0-\x1f\x7f]/.test(n)) throw new Error('Invalid name')
}
const assertPort = (p: number) => {
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`Invalid port: ${p}`)
}
const RESERVED_PORTS: Record<number, string> = { 53: 'DNS', 67: 'DHCP', 68: 'DHCP', 123: 'NTP', 5353: 'mDNS', 5354: 'safe DNS' }
/** Evita romper DNS/DHCP/NTP/mDNS al mover los puertos web. */
const assertWebPort = (p: number) => {
  assertPort(p)
  if (RESERVED_PORTS[p]) throw new Error(`Port ${p} is reserved for ${RESERVED_PORTS[p]}. Choose another so you do not affect the network.`)
}

const DEFAULT_WEB_PORTS = { http: 80, https: 443 }

/** URL del sitio con el esquema y el puerto reales que sirve nginx. */
export function siteUrlFor(name: string, tld: string, secure: boolean, port: number): string {
  const scheme = secure ? 'https' : 'http'
  try {
    const url = new URL(`${scheme}://${name}.${tld}${port === DEFAULT_WEB_PORTS[scheme] ? '' : `:${port}`}`)
    // Rechaza nombres que el parser interpreta como usuario@host.
    if (url.username || url.password) return ''
    return url.href
  } catch { return '' }
}

// ---------------- Sitios ----------------
async function valetConfig(): Promise<{ tld: string; paths: string[] }> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(VALET, 'config.json'), 'utf8'))
    const c = (raw && typeof raw === 'object' ? raw : {}) as { tld?: unknown; domain?: unknown; paths?: unknown }
    const rawTld = typeof c.domain === 'string' ? c.domain : c.tld
    const tld = typeof rawTld === 'string' && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(rawTld.trim()) ? rawTld.trim() : 'test'
    const paths = Array.isArray(c.paths)
      ? c.paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map(expandHome)
      : []
    return { tld, paths }
  } catch { return { tld: 'test', paths: [] } }
}

/** Dominio que Valet usa para los sitios (config.json escribe "domain"). */
export async function valetDomain(): Promise<string> {
  return (await valetConfig()).tld
}

export async function listSites(): Promise<Site[]> {
  const { tld, paths } = await valetConfig()
  const { http, https } = await detectNginxPorts(await nginxFiles())
  const sites = new Map<string, Site>()
  const add = async (dir: string, kind: Site['kind']) => {
    if (!existsSync(dir)) return
    let entries: string[]
    try { entries = await readdir(dir) } catch { return }
    for (const e of entries) {
      const full = join(dir, e)
      try {
        if (!(await stat(full)).isDirectory()) continue
        // Un enlace (valet link) tiene prioridad sobre un parked con el mismo nombre.
        if (kind === 'parked' && sites.has(e)) continue
        const secure = existsSync(join(VALET, 'Certificates', `${e}.${tld}.crt`))
        sites.set(e, {
          name: e, kind, path: await realpath(full), secure,
          url: siteUrlFor(e, tld, secure, secure ? https : http)
        })
      } catch { /* enlace roto */ }
    }
  }
  const linksDir = resolve(LINKS_DIR)
  for (const p of paths) {
    if (resolve(p) === linksDir) continue
    await add(p, 'parked')
  }
  await add(linksDir, 'linked')
  return [...sites.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function setSecure(name: string, on: boolean) {
  assertName(name)
  await prepareHelpers()
  await runValet([on ? 'secure' : 'unsecure', name])
}

/**
 * Comprueba que borrar la carpeta de un sitio no se lleve por delante una raíz,
 * una carpeta parkeada completa ni los datos de Valet o del panel. Los enlaces
 * pueden apuntar fuera de las rutas parkeadas, así que además se exige que la
 * ruta exista y sea una carpeta real.
 */
async function assertDeletable(site: Site): Promise<void> {
  const target = resolve(site.path)
  if (target === sep) throw new Error('Refusing to delete the filesystem root.')
  for (const protectedPath of [resolve(HOME), resolve(VALET), resolve(APP)]) {
    if (target === protectedPath || protectedPath.startsWith(`${target}${sep}`)) {
      throw new Error('Refusing to delete this folder: it contains Valet or Valet Deck data.')
    }
  }
  const { paths } = await valetConfig()
  const parkedRoots = paths.map((p) => resolve(p))
  if (parkedRoots.includes(target)) {
    throw new Error('Refusing to delete a parked folder root. Remove it from Settings → Parked folders first.')
  }
  if (site.kind === 'parked' && !parkedRoots.some((root) => target.startsWith(`${root}${sep}`))) {
    throw new Error('Refusing to delete a folder that is not inside a parked path.')
  }
  const info = await stat(target).catch(() => null)
  if (!info?.isDirectory()) throw new Error('The site folder does not exist.')
}

/**
 * Quita un sitio de Valet. Un sitio enlazado se puede quitar dejando la carpeta
 * en disco; uno parkeado solo desaparece de la lista borrando su carpeta. En
 * ambos casos se retira antes el certificado HTTPS, si existe.
 */
export async function removeSite(
  name: string,
  options: { deleteFiles?: boolean } = {}
): Promise<void> {
  assertName(name)
  const site = (await listSites()).find((s) => s.name === name)
  if (!site) throw new Error(`Unknown site: ${name}`)
  const deleteFiles = options.deleteFiles === true
  if (site.kind === 'parked' && !deleteFiles) {
    throw new Error('A site inside a parked folder is removed by deleting its folder.')
  }
  if (deleteFiles) await assertDeletable(site)
  if (site.secure || site.kind === 'linked') {
    await prepareHelpers()
    if (site.secure) await runValet(['unsecure', name])
    if (site.kind === 'linked') await runValet(['unlink', name])
  }
  if (deleteFiles) await rm(site.path, { recursive: true, force: true })
}

/** URL que debe abrir el navegador para un sitio (respeta HTTPS y los puertos de nginx). */
export async function siteUrl(name: string): Promise<string> {
  assertName(name)
  const { tld } = await valetConfig()
  const secure = existsSync(join(VALET, 'Certificates', `${name}.${tld}.crt`))
  const { http, https } = await detectNginxPorts(await nginxFiles())
  const url = siteUrlFor(name, tld, secure, secure ? https : http)
  if (!url) throw new Error('The site name cannot be opened in the browser')
  return url
}

// ---------------- Crear proyectos Laravel ----------------
let creatingProject = false
let incompleteTarget: string | null = null

const linksDirReal = () => realpath(LINKS_DIR).catch(() => resolve(LINKS_DIR))

async function isInLinksDir(dir: string): Promise<boolean> {
  const linksDir = await linksDirReal()
  return dir === linksDir || dir.startsWith(linksDir + sep)
}

function assertProjectName(name: string) {
  if (!PROJECT_NAME_RE.test(name)) {
    throw new Error('Invalid project name: use lowercase letters, numbers and hyphens, without starting or ending with a hyphen (max. 63).')
  }
}

async function projectParentDir(input: unknown): Promise<string> {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Choose a folder for the project.')
  const expanded = expandHome(input.trim())
  if (!isAbsolute(expanded)) throw new Error('The folder must be an absolute path or start with ~/.')
  let parent: string
  try { parent = await realpath(expanded) } catch { throw new Error('The destination folder does not exist.') }
  if (!(await stat(parent)).isDirectory()) throw new Error('The destination path is not a folder.')
  if (await isInLinksDir(parent)) {
    throw new Error('The ~/.valet/Sites folder is reserved for Valet links. Choose another projects folder.')
  }
  try { await access(parent, fsConstants.W_OK) } catch { throw new Error('The destination folder is not writable.') }
  return parent
}

async function isParkedDir(dir: string): Promise<boolean> {
  if (await isInLinksDir(dir)) return false
  const { paths } = await valetConfig()
  for (const p of paths) {
    try { if ((await realpath(p)) === dir) return true } catch { /* ruta inexistente */ }
  }
  return false
}

/** Datos que necesita el asistente de creación antes de ejecutar `laravel new`. */
export async function projectInfo(): Promise<ProjectInfo> {
  const { tld, paths } = await valetConfig()
  const parkedPaths: string[] = []
  const linksDir = await linksDirReal()
  for (const p of paths) {
    try {
      const real = await realpath(p)
      if (real === linksDir || real.startsWith(linksDir + sep)) continue
      if ((await stat(real)).isDirectory() && !parkedPaths.includes(real)) parkedPaths.push(real)
    } catch { /* ruta inexistente */ }
  }
  const fallback = join(HOME, 'Sites')
  const defaultDir = parkedPaths[0] ?? (existsSync(fallback) ? fallback : HOME)
  const { http } = await detectNginxPorts(await nginxFiles())
  const [composer, valet, installer, mariadb] = await Promise.all([
    run('composer', ['--version'], true),
    run('valet', ['--version'], true),
    detectLaravel(),
    readMariaDbCredentials()
  ])
  return {
    domain: tld,
    parkedPaths,
    defaultDir,
    httpPort: http,
    composerAvailable: composer.trim() !== '',
    valetAvailable: valet.trim() !== '',
    installer: { available: Boolean(installer), version: installer?.version ?? null },
    capabilities: await laravelCapabilities(installer),
    mariadb
  }
}

/** Escribe en `.env` los valores elegidos; en `.env.example`, solo los no secretos. */
async function patchProjectEnv(
  target: string,
  driver: LaravelAnswers['database'],
  connection: DatabaseConnection | null,
  appUrl: string | null
): Promise<void> {
  const values = projectEnvValues(driver, connection, appUrl)
  if (!Object.keys(values).length) return
  const envFile = join(target, '.env')
  const current = await readFile(envFile, 'utf8')
  await writeFile(envFile, patchEnv(current, values))

  const example = { ...values }
  delete example.DB_PASSWORD
  try {
    const content = await readFile(join(target, '.env.example'), 'utf8')
    await writeFile(join(target, '.env.example'), patchEnv(content, example))
  } catch { /* el esqueleto puede no traer .env.example */ }
}

/** Detiene el `laravel new` en curso y deja constancia de la cancelación. */
export async function cancelCreateProject(): Promise<void> {
  cancelLaravelNew()
}

/**
 * Borra la carpeta que quedó a medias tras una creación fallida. Solo acepta
 * exactamente la última que registró el proceso principal: nunca una ruta
 * arbitraria del renderer, un enlace de Valet ni un sitio ya registrado.
 */
export async function deleteIncompleteProject(path: unknown): Promise<void> {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Invalid path.')
  const target = resolve(expandHome(path.trim()))
  if (!incompleteTarget || target !== incompleteTarget) {
    throw new Error('Only the incomplete folder from the last failed creation can be deleted.')
  }
  if (await isInLinksDir(target)) {
    throw new Error('The folder is inside the Valet links; it is not deleted from here.')
  }
  if (!PROJECT_NAME_RE.test(basename(target))) throw new Error('The path does not look like a project folder.')
  const sites = await listSites()
  if (sites.some((s) => resolve(s.path) === target)) {
    throw new Error('The folder is already a Valet site. Delete it from the site list.')
  }
  if (!existsSync(target)) {
    incompleteTarget = null
    return
  }
  if (!(await stat(target)).isDirectory()) throw new Error('The path is not a folder.')
  await rm(target, { recursive: true, force: true })
  incompleteTarget = null
}

export async function createLaravelProject(opts: CreateProjectOptions, emit: (e: CreateProjectEvent) => void): Promise<Site> {
  if (creatingProject) throw new Error('A project creation is already running.')
  creatingProject = true
  incompleteTarget = null
  let target = ''
  let mayHaveCreated = false
  try {
    const answers = opts?.answers
    if (!answers || typeof answers !== 'object') throw new Error('The wizard answers are missing.')
    const name = typeof answers.name === 'string' ? answers.name.trim() : ''
    assertProjectName(name)

    const parent = await projectParentDir(opts?.parentDir)
    target = join(parent, name)
    if (existsSync(target)) throw new Error(`${target} already exists. Choose another name or folder.`)
    if ((await listSites()).some((s) => s.name === name)) throw new Error(`A site named ${name} already exists.`)

    const valet = await run('valet', ['--version'], true)
    if (!valet.trim()) throw new Error('Valet is not installed. Install it from the Installation tab.')

    // Si no hay instalador, ensureLaravel lo instala en el Composer aislado.
    const installer = await ensureLaravel(emit)
    const capabilities = await laravelCapabilities(installer)
    const normalized: LaravelAnswers = { ...answers, name }
    const database = opts.database ?? null
    const errors = validateAnswers(normalized, capabilities)
    if (normalized.database !== 'sqlite') {
      if (!database) errors.push('The database credentials are missing.')
      else errors.push(...validateDatabase(database))
    }
    if (errors.length) throw new Error(errors.join(' '))

    // Como Flock: la base debe existir antes de que el instalador ejecute las
    // migraciones. Se crea con las mismas credenciales que usará el proyecto.
    if (normalized.database !== 'sqlite') {
      emit({ type: 'stage', label: 'Preparing the database…' })
      await ensureProjectDatabase(normalized.database, database, (text) => emit({ type: 'log', text }))
    }

    emit({ type: 'stage', label: 'Creating the project with the Laravel installer…' })
    mayHaveCreated = true
    await runLaravelNew(installer, parent, normalized, database, emit)

    emit({ type: 'stage', label: 'Saving the database configuration…' })
    try {
      await patchProjectEnv(target, normalized.database, database, null)
    } catch {
      emit({ type: 'log', text: '\nCould not write the database configuration to .env; check it before using the project.\n' })
    }

    emit({ type: 'stage', label: 'Registering the site in Valet…' })
    if (!(await isParkedDir(parent))) {
      await prepareHelpers()
      try {
        await runValet(['link', name], false, target)
      } catch (e) {
        throw new Error(`The project was created at ${target}, but it could not be linked in Valet: ${(e as Error).message}`)
      }
    }

    emit({ type: 'stage', label: 'Refreshing the site list…' })
    const site = (await listSites()).find((s) => s.name === name)
    if (!site) throw new Error(`The project was created at ${target}, but it does not appear in the Valet list.`)

    // El instalador deja APP_URL con el dominio por defecto y sin el puerto real.
    try {
      await patchProjectEnv(target, normalized.database, database, site.url ? site.url.replace(/\/$/, '') : null)
    } catch { emit({ type: 'log', text: '\nCould not update APP_URL in .env; the rest of the project is ready.\n' }) }

    emit({ type: 'stage', label: 'Project created' })
    return site
  } catch (e) {
    // Solo se ofrece borrar una carpeta que este intento pudo crear: nunca una
    // que ya existía antes y provocó el rechazo.
    if (mayHaveCreated && target && existsSync(target)) {
      incompleteTarget = resolve(target)
      emit({ type: 'incomplete', path: incompleteTarget, message: (e as Error).message })
    }
    throw e
  } finally {
    creatingProject = false
  }
}

// ---------------- PHP ----------------
/**
 * El panel fija PHP 8.5 solo en las Ubuntu que cubre el PPA de Ondrej (LTS con
 * soporte). En Debian, en Ubuntu sin soporte y en el resto de distribuciones se
 * usa el PHP único del sistema. Misma regla que el instalador: `planPhp`.
 */
async function phpTargetVersion(): Promise<string | null> {
  const t = await readFile('/etc/os-release', 'utf8').catch(() => '')
  return planPhp(detectPlatform(t), PHP_VERSION).version
}

/**
 * Estado del PHP que gestiona el panel. No enumera versiones ni cambia entre
 * ellas: `target` es la versión fijada (`null` si es la de la distribución),
 * `current` es lo que reporta `php` y `managed` es la versión sobre la que se
 * calcula el estado de PHP-FPM.
 */
export async function phpInfo(): Promise<PhpInfo> {
  const target = await phpTargetVersion()
  const current = (await run('php', ['-r', 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;'], true)).trim()
  const version = /^\d+\.\d+$/.test(current) ? current : ''
  const managed = target ?? version
  // Con versión fijada solo cuenta su binario concreto: un `php-fpm` genérico
  // puede pertenecer a otra versión.
  const binaries = managed
    ? target
      ? [`/usr/sbin/php-fpm${managed}`, `/usr/bin/php-fpm${managed}`]
      : [`/usr/sbin/php-fpm${managed}`, `/usr/bin/php-fpm${managed}`, '/usr/sbin/php-fpm', '/usr/bin/php-fpm']
    : []
  const installed = binaries.some((path) => existsSync(path))
  const units = managed
    ? target
      ? [`php${managed}-fpm`]
      : [`php${managed}-fpm`, 'php-fpm']
    : []
  let fpmActive = false
  for (const unit of units) {
    if ((await run('systemctl', ['is-active', unit], true)).trim() === 'active') {
      fpmActive = true
      break
    }
  }
  return { target, current, managed, installed, fpmActive }
}

/**
 * `valet use` de cpriego/valet-linux 2.4.5 mete el argumento tal cual en
 * `php{$version}-fpm`, sin normalizarlo: `php@8.5` acaba pidiendo
 * `phpphp@8.5-fpm` y la instalación falla. Solo acepta la versión limpia.
 */
export function phpUseArgs(version: string = PHP_VERSION): string[] {
  if (!/^\d+\.\d+$/.test(version)) throw new Error('Invalid version')
  return ['use', version]
}

// ---------------- Puertos ----------------
const validPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535

async function appConfig(): Promise<AppConfig> {
  try {
    const c = JSON.parse(await readFile(join(APP, 'config.json'), 'utf8')) as Partial<AppConfig>
    const http = typeof c.http === 'number' && validPort(c.http) ? c.http : 80
    const https = typeof c.https === 'number' && validPort(c.https) ? c.https : 443
    const a = c.apache
    const apache = a && typeof a.http === 'number' && validPort(a.http) && typeof a.https === 'number' && validPort(a.https)
      ? { http: a.http, https: a.https } : undefined
    return apache ? { http, https, apache } : { http, https }
  } catch { return { http: 80, https: 443 } }
}

async function saveConfig(patch: Partial<AppConfig>) {
  await mkdir(APP, { recursive: true })
  await writeFile(join(APP, 'config.json'), JSON.stringify({ ...(await appConfig()), ...patch }, null, 2))
}

export const portFromAddress = (addr: string): number | null => {
  const only = addr.trim().split(/\s+/)[0]
  const port = Number(only.slice(only.lastIndexOf(':') + 1))
  return validPort(port) ? port : null
}

/**
 * Nombre legible del dueño de un socket a partir de su cgroup. `ss -e` muestra
 * el cgroup incluso cuando el proceso pertenece a otro usuario y `-p` lo
 * oculta; así un servicio raíz no se etiqueta como «otro usuario».
 */
export function cgroupOwner(cgroup: string): string | null {
  const unit = cgroup.split('/').filter(Boolean).pop() ?? ''
  if (!/\.service$/.test(unit)) return null
  const base = unit.replace(/\.service$/, '')
  // Flock instala una unidad de plantilla; el nombre del servicio no dice nada
  // por sí solo y conviene que la persona vea de qué unidad se trata.
  if (/^flock@/.test(base)) return `Flock (${unit})`
  return base
}

/** Unidad de systemd del cgroup, tal cual: `flock@jhony.service`. */
export function cgroupUnit(cgroup: string): string {
  const unit = cgroup.split('/').filter(Boolean).pop() ?? ''
  return /^[A-Za-z0-9@_.:-]+\.service$/.test(unit) ? unit : ''
}

async function listenUsage(): Promise<PortUsage[]> {
  // `-e` añade uid y cgroup: sin ellos, `-p` oculta los procesos de root y la
  // interfaz los presentaba como «otro usuario».
  const out = await run('ss', ['-tlnpHe'], true)
  const usage: PortUsage[] = []
  for (const line of out.split('\n')) {
    const c = line.trim().split(/\s+/)
    if (c.length < 5) continue
    const port = Number(c[3].slice(c[3].lastIndexOf(':') + 1))
    if (!validPort(port)) continue
    const p = line.match(/\("([^"]+)",pid=(\d+)/)
    const cgroup = line.match(/\bcgroup:(\S+)/)?.[1] ?? ''
    const uid = line.match(/\buid:(\d+)/)?.[1] ?? ''
    const owner = p?.[1] ?? cgroupOwner(cgroup) ?? (uid ? `uid ${uid}` : '—')
    if (!usage.some((u) => u.port === port)) {
      usage.push({ port, process: owner, pid: p?.[2] ?? '', unit: cgroupUnit(cgroup) })
    }
  }
  return usage.sort((a, b) => a.port - b.port)
}

const isActive = async (service: string) => (await run('systemctl', ['is-active', service], true)).trim() === 'active'
const isEnabled = async (service: string) => (await run('systemctl', ['is-enabled', service], true)).trim() === 'enabled'

async function nginxFiles(): Promise<{ file: string; root: boolean }[]> {
  const files: { file: string; root: boolean }[] = []
  const dir = join(VALET, 'Nginx')
  if (existsSync(dir)) {
    for (const f of await readdir(dir)) if (f.endsWith('.conf')) files.push({ file: join(dir, f), root: false })
  }
  if (existsSync(NGINX_SYSTEM)) files.push({ file: NGINX_SYSTEM, root: true })
  return files
}

/** Puertos reales de nginx, para no depender solo de lo último guardado por la app. */
async function detectNginxPorts(files: { file: string }[]): Promise<{ http: number; https: number }> {
  let http: number | undefined
  let https: number | undefined
  for (const { file } of files) {
    let src = ''
    try { src = await readFile(file, 'utf8') } catch { continue }
    for (const m of src.matchAll(/^\s*listen\s+([^;#]+);/gmi)) {
      const port = portFromAddress(m[1])
      if (!port) continue
      if (/\bssl\b/i.test(m[1])) https ??= port
      else http ??= port
    }
  }
  const saved = await appConfig()
  return { http: http ?? saved.http, https: https ?? saved.https }
}

/**
 * Puertos pedidos que otro proceso ocupa. Los que no cambian (`current`) se
 * ignoran: nginx o Apache ya los tienen y `ss -p` puede ocultar su nombre.
 */
export function conflictingPorts(
  usage: PortUsage[], requested: number[], current: number[], owner: RegExp
): PortUsage[] {
  const keep = new Set(current)
  return usage.filter((u) => requested.includes(u.port) && !keep.has(u.port) && !owner.test(u.process))
}

async function assertPortsFree(ports: number[], owner: RegExp, current: number[] = []) {
  const used = conflictingPorts(await listenUsage(), ports, current, owner)[0]
  if (used) {
    const who = used.process === '—' ? 'another process' : used.process
    throw new Error(`Port ${used.port} is already in use by ${who}${used.pid ? ` (pid ${used.pid})` : ''}. Choose another port.`)
  }
}

async function backupFile(file: string, stamp: string, kind: string, root: boolean): Promise<Changed> {
  const dir = join(APP, 'backups', stamp, kind)
  await mkdir(dir, { recursive: true })
  const backup = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${basename(file)}`)
  await copyFile(file, backup)
  return { file, backup, root }
}

/** Restaura las copias y devuelve los archivos que no se pudieron recuperar. */
async function restoreFiles(changed: Changed[]): Promise<string[]> {
  const failed: string[] = []
  for (const c of changed) {
    try {
      if (c.root) await sudo('cp', [c.backup, c.file])
      else await copyFile(c.backup, c.file)
    } catch { failed.push(c.file) }
  }
  return failed
}

const restoreNote = (failed: string[]) =>
  failed.length ? `\nCould not restore: ${failed.join(', ')}` : ''

async function writePrivileged(file: string, content: string) {
  const tmp = join(tmpdir(), `valet-dash-${process.pid}-${Date.now()}-${basename(file)}`)
  await writeFile(tmp, content)
  try { await sudo('cp', [tmp, file]) } finally { await rm(tmp, { force: true }).catch(() => '') }
}

async function patchFile(file: string, transform: (src: string) => string, root: boolean, stamp: string, kind: string): Promise<Changed | null> {
  if (!existsSync(file)) return null
  const src = await readFile(file, 'utf8')
  const out = transform(src)
  if (out === src) return null
  const changed = await backupFile(file, stamp, kind, root)
  if (root) await writePrivileged(file, out)
  else await writeFile(file, out)
  return changed
}

export const nginxTransform = (map: Record<number, number>) => (src: string) =>
  src.replace(/(^\s*listen\s+(?:\[[^\]]*\]:|[^\s:]+:)?)(\d+)/gmi, (m, pre: string, port: string) => {
    const to = map[Number(port)]
    return to ? `${pre}${to}` : m
  })

export async function scanPorts(): Promise<PortsInfo> {
  const files = await nginxFiles()
  const [usage, config, apache, nginxActive] = await Promise.all([
    listenUsage(), detectNginxPorts(files), apacheInfo(), isActive('nginx')
  ])
  return { config, usage, nginxActive, apache }
}

/** Puerto HTTP real de nginx, para comprobar que un sitio responde. */
export async function valetHttpPort(): Promise<number> {
  const files = await nginxFiles()
  const { http } = await detectNginxPorts(files)
  return http
}

export async function setPorts(http: number, https: number) {
  assertWebPort(http); assertWebPort(https)
  if (http === https) throw new Error('HTTP and HTTPS cannot use the same port')
  const files = await nginxFiles()
  if (!files.length) throw new Error('The Valet nginx configuration was not found. Install Valet first.')
  const current = await detectNginxPorts(files)
  if (http === current.http && https === current.https) return
  if (current.http === current.https)
    throw new Error(`The current nginx configuration uses the same port (${current.http}) for HTTP and HTTPS. Fix it before changing it from here.`)
  await assertPortsFree(
    [http, https],
    /^nginx$/i,
    (await isActive('nginx')) ? [current.http, current.https] : []
  )
  const map: Record<number, number> = { [current.http]: http, [current.https]: https }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const changed: Changed[] = []
  try {
    for (const { file, root } of files) {
      const c = await patchFile(file, nginxTransform(map), root, stamp, 'nginx')
      if (c) changed.push(c)
    }
  } catch (e) {
    const failed = await restoreFiles(changed)
    const msg = (e as Error).message.trim()
    const state = failed.length ? 'the previous one could not be fully restored' : 'the previous one was restored'
    throw new Error(`Could not write the nginx changes; ${state}.${restoreNote(failed)}${msg ? `\n${msg}` : ''}`)
  }
  if (!changed.length) throw new Error('No listen directives were found to update. Check the Valet configuration.')
  const wasActive = await isActive('nginx')
  try {
    await sudo('nginx', ['-t'])
    if (wasActive) await sudo('systemctl', ['reload', 'nginx'])
    else await sudo('systemctl', ['start', 'nginx'])
  } catch (e) {
    const failed = await restoreFiles(changed)
    if (wasActive) await sudo('systemctl', ['reload', 'nginx']).catch(() => '')
    const msg = (e as Error).message.trim()
    const state = failed.length ? 'the previous one could not be fully restored' : 'the previous one was restored'
    throw new Error(`nginx rejected the configuration; ${state}.${restoreNote(failed)}${msg ? `\n${msg}` : ''}`)
  }
  await saveConfig({ http, https })
}

// ---------------- Apache ----------------
async function apacheFiles(includeAvailable = false): Promise<string[]> {
  const files: string[] = []
  if (existsSync(APACHE_PORTS)) files.push(APACHE_PORTS)
  const dirs = includeAvailable ? [APACHE_SITES, join(APACHE_DIR, 'sites-available')] : [APACHE_SITES]
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.conf')) continue
      try { files.push(await realpath(join(dir, f))) } catch { /* enlace roto */ }
    }
  }
  return [...new Set(files)]
}

async function parseApachePorts(files: string[]): Promise<{ http: number | null; https: number | null }> {
  let vhostHttp: number | null = null
  let vhostHttps: number | null = null
  const listens: number[] = []
  for (const file of files) {
    let src = ''
    try { src = await readFile(file, 'utf8') } catch { continue }
    for (const m of src.matchAll(/^\s*Listen\s+([^\s#;]+)/gmi)) {
      const port = portFromAddress(m[1])
      if (port) listens.push(port)
    }
    for (const m of src.matchAll(/<VirtualHost\b([^>]*)>([\s\S]*?)<\/VirtualHost>/gi)) {
      const ssl = /SSLEngine\s+on/i.test(m[2])
      for (const pm of m[1].matchAll(/:(\d+)\b/g)) {
        const port = Number(pm[1])
        if (ssl && vhostHttps == null) vhostHttps = port
        else if (!ssl && vhostHttp == null) vhostHttp = port
      }
    }
  }
  const listenHttps = listens.includes(443) ? 443 : null
  const listenHttp = listens.find((p) => p !== listenHttps) ?? null
  return { http: listenHttp ?? vhostHttp, https: listenHttps ?? vhostHttps }
}

export async function apacheInfo(): Promise<ApacheInfo> {
  if (!existsSync(APACHE_PORTS)) return { installed: false, active: false, enabled: false, http: null, https: null }
  const parsed = await parseApachePorts(await apacheFiles())
  const saved = (await appConfig()).apache
  const [active, enabled] = await Promise.all([isActive('apache2'), isEnabled('apache2')])
  return {
    installed: true, active, enabled,
    http: parsed.http ?? saved?.http ?? null,
    https: parsed.https ?? saved?.https ?? null
  }
}

export const apacheTransform = (map: Record<number, number>) => (src: string) => {
  let out = src.replace(/(^\s*Listen\s+(?:\[[^\]]*\]:|[^\s:#]+:)?)(\d+)/gmi, (m, pre: string, port: string) => {
    const to = map[Number(port)]
    return to ? `${pre}${to}` : m
  })
  out = out.replace(/<VirtualHost\b[^>]*>/gi, (tag) =>
    tag.replace(/:(\d+)\b/g, (m, port: string) => map[Number(port)] ? `:${map[Number(port)]}` : m))
  return out
}

export async function setApachePorts(http: number, https: number) {
  assertWebPort(http); assertWebPort(https)
  if (http === https) throw new Error('HTTP and HTTPS cannot use the same port')
  if (!existsSync(APACHE_PORTS)) throw new Error('Apache is not installed on this system')
  const activeFiles = await apacheFiles()
  const allFiles = await apacheFiles(true)
  if (!allFiles.length) throw new Error('The Apache configuration was not found')
  const parsed = await parseApachePorts(activeFiles)
  const saved = (await appConfig()).apache
  const current = { http: parsed.http ?? saved?.http ?? null, https: parsed.https ?? saved?.https ?? null }
  if (current.http == null || current.https == null)
    throw new Error('Could not detect the current Apache ports (check ports.conf and the VirtualHosts)')
  if (http === current.http && https === current.https) return
  if (current.http === current.https)
    throw new Error(`The current Apache configuration uses the same port (${current.http}) for HTTP and HTTPS. Fix it before changing it from here.`)
  await assertPortsFree(
    [http, https],
    /^(apache2?|httpd)$/i,
    (await isActive('apache2')) ? [current.http, current.https] : []
  )
  const map: Record<number, number> = { [current.http]: http, [current.https]: https }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const changed: Changed[] = []
  try {
    for (const file of allFiles) {
      const c = await patchFile(file, apacheTransform(map), true, stamp, 'apache')
      if (c) changed.push(c)
    }
  } catch (e) {
    const failed = await restoreFiles(changed)
    const msg = (e as Error).message.trim()
    const state = failed.length ? 'the previous one could not be fully restored' : 'the previous one was restored'
    throw new Error(`Could not write the Apache changes; ${state}.${restoreNote(failed)}${msg ? `\n${msg}` : ''}`)
  }
  if (!changed.length) throw new Error('No Listen directives or VirtualHosts were found to update in Apache.')
  const wasActive = await isActive('apache2')
  try {
    await sudo('apache2ctl', ['configtest'])
    if (wasActive) await sudo('systemctl', ['reload', 'apache2'])
  } catch (e) {
    const failed = await restoreFiles(changed)
    if (wasActive) await sudo('systemctl', ['reload', 'apache2']).catch(() => '')
    const msg = (e as Error).message.trim()
    const state = failed.length ? 'the previous one could not be fully restored' : 'the previous one was restored'
    throw new Error(`Apache rejected the configuration; ${state}.${restoreNote(failed)}${msg ? `\n${msg}` : ''}`)
  }
  await saveConfig({ apache: { http, https } })
}

// ---------------- Servicios ----------------
const WANTED = /^(nginx|dnsmasq|valet-dns|valet-studio-dns|apache2|mysql|mysqld|mariadb|redis|redis-server|postgresql(?:@\d+-\w+)?|php\d+\.\d+-fpm)\.service$/

export async function listServices(): Promise<Service[]> {
  const units = await run('systemctl', ['list-unit-files', '--type=service', '--no-legend', '--no-pager'], true)
  const names = units.split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 2 && WANTED.test(c[0]) && c[1] !== 'alias')
    .map((c) => c[0].replace('.service', ''))
  if (!names.length) return []
  const st = (await run('systemctl', ['is-active', ...names], true)).trim().split('\n')
  return names.map((name, i) => ({ name, active: st[i] === 'active' }))
}

export async function serviceAction(name: string, action: ServiceAction) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Invalid action')
  if (!(await listServices()).some((s) => s.name === name)) throw new Error('Unknown service')
  await sudo('systemctl', [action, name])
}

/** Unidad que ocupa los puertos web de Valet y no es nginx, si la hay. */
export interface WebPortConflict {
  unit: string
  process: string
  ports: number[]
}

/**
 * Busca el proceso que impide arrancar a nginx. Es una función pura para
 * probarla con la salida real de `ss`: agrupa por unidad de systemd y prefiere
 * la que ocupa HTTPS, que es la que de verdad bloquea el arranque.
 */
export function webPortConflict(info: PortsInfo): WebPortConflict | null {
  const wanted = new Set([info.config.http, info.config.https])
  const holders = info.usage.filter((u) => wanted.has(u.port) && u.unit && !/^nginx/i.test(u.process))
  if (!holders.length) return null
  const byUnit = new Map<string, WebPortConflict>()
  for (const holder of holders) {
    const entry = byUnit.get(holder.unit) ?? { unit: holder.unit, process: holder.process, ports: [] }
    if (!entry.ports.includes(holder.port)) entry.ports.push(holder.port)
    byUnit.set(holder.unit, entry)
  }
  const all = [...byUnit.values()]
  return all.find((c) => c.ports.includes(info.config.https)) ?? all[0]
}

/**
 * Libera 80/443 parando el servicio que los ocupa y arranca nginx. Solo se
 * ofrece cuando la unidad se detectó escuchando en esos puertos: nunca se para
 * un servicio por su nombre. La decisión (y el aviso de que Flock dejará de
 * servir) es de la persona, que confirma en la interfaz.
 */
export async function freeWebPorts(keepOff = false): Promise<void> {
  return freeWebPortsWith(await scanPorts(), keepOff)
}

/**
 * Misma acción que `freeWebPorts`, pero con el escaneo ya hecho. Se separa
 * para poder probar la secuencia exacta de systemctl sin tocar la máquina:
 * parar al dueño, desactivarlo solo si se pidió y arrancar nginx siempre.
 */
export async function freeWebPortsWith(info: PortsInfo, keepOff = false): Promise<void> {
  const conflict = webPortConflict(info)
  let disableError: unknown = null
  if (conflict) {
    await sudo('systemctl', ['stop', conflict.unit])
    // Desactivar al arranque es una decisión aparte: solo se hace cuando la
    // persona marcó «Keep it off at boot». Sin marcar, el otro entorno vuelve
    // a tomar los puertos tras reiniciar, y la interfaz lo avisa.
    if (keepOff) {
      try {
        await sudo('systemctl', ['disable', conflict.unit])
      } catch (err) {
        // nginx debe arrancar igualmente: el servicio ya está parado y dejar
        // los sitios sin servidor sería peor que fallar solo al desactivar.
        disableError = err
      }
    }
  }
  await sudo('systemctl', ['start', 'nginx'])
  if (disableError) {
    const message = disableError instanceof Error ? disableError.message : String(disableError)
    throw new Error(`nginx is running, but ${conflict?.unit} could not be disabled at boot: ${message}`)
  }
}

/**
 * Últimas líneas del journal de una unidad. Solo lectura y sin elevar
 * privilegios: si el usuario no pertenece a `systemd-journal`, journalctl
 * devuelve vacío y la interfaz lo dice en vez de inventar un error.
 */
export async function serviceLogs(name: string, lines = 200): Promise<string> {
  if (!(await listServices()).some((s) => s.name === name)) throw new Error('Unknown service')
  const count = Math.min(1000, Math.max(20, Math.round(Number(lines) || 200)))
  const out = await run('journalctl', ['-u', name, '-n', String(count), '--no-pager', '-o', 'short-iso'], true)
  return out.trim()
}
