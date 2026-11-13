// Detalle completo de un sitio: qué framework es, qué versiones usa, cómo se
// conecta a la base de datos y al correo, qué workers tiene y qué dicen sus
// registros. Todo se lee del proyecto y de Valet; nada se inventa.
//
// Las contraseñas nunca salen de este módulo: el renderer recibe `passwordSet`
// y, para editar, envía un valor nuevo. El `.env` se copia antes de escribir.

import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import type {
  DatabaseEngine, EnvWrite, SiteDatabase, SiteDatabaseInput, SiteDetail, SiteEnvEntry, SiteExtension,
  SiteMail, SiteMailInput, SiteSettingsPatch, SiteLog
} from '../shared/site'
import {
  applyEnvChanges, envValue, inboxName, mailEncryptionOf, mailEnvBlock, mailSchemePair,
  parseEnv, pickFramework, pinnedNodeVersion, pinnedPhpVersion, type ParsedEnv
} from '../shared/site-files'
import {
  defaultDatabasePort, validateDatabase,
  type DatabaseConnection, type DatabaseDriver
} from '../shared/laravel'
import { run, runWithEnv, env as execEnv } from './exec'
import { listSites, valetDomain } from './valet'
import {
  composerPhpConstraint, defaultPhpVersion, installedPhpVersions, isolatedSiteConfig, isolatedSites, requiredExtensions
} from './php-versions'
import { nodeVersionsInfo } from './node-versions'
import { queueLogFile, queueState } from './queue'
import { readSiteSettings, writeSiteSettings } from './site-store'
import { databaseClientCandidates, ensureProjectDatabase, planDatabaseCommand } from './database-setup'
import { configureEnv, smtpPort } from './mail'
import { MAIL_HOST, MAIL_PORT } from '../shared/mail'

const HOME = homedir()
const BACKUPS = join(HOME, '.valet-studio', 'backups')

const SQL_DRIVERS: DatabaseDriver[] = ['mysql', 'mariadb', 'pgsql', 'sqlsrv']

const isSqlDriver = (value: string): value is DatabaseDriver =>
  SQL_DRIVERS.includes(value as DatabaseDriver)

async function findSite(name: string) {
  const sites = await listSites()
  const site = sites.find((s) => s.name === name)
  if (!site) throw new Error(`Unknown site: ${name}`)
  return site
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function fileSize(file: string): Promise<number> {
  return (await stat(file).catch(() => ({ size: 0 }))).size
}

/** `tail -c` de un archivo grande sin cargarlo entero en memoria. */
async function tailFile(file: string, bytes = 96_000): Promise<string> {
  const size = await fileSize(file)
  if (!size) return ''
  if (size <= bytes) return (await readText(file)) ?? ''
  return run('tail', ['-c', String(bytes), file], true)
}

async function readComposer(path: string): Promise<unknown> {
  const text = await readText(join(path, 'composer.json'))
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

async function laravelVersion(path: string): Promise<string | null> {
  const lock = await readText(join(path, 'composer.lock'))
  if (!lock) return null
  try {
    const data = JSON.parse(lock) as { packages?: { name?: string; version?: string }[] }
    return data.packages?.find((p) => p.name === 'laravel/framework')?.version ?? null
  } catch { return null }
}

/** Archivo del proyecto que fija la versión de Node, en orden de precedencia. */
async function pinnedNode(path: string): Promise<{ file: string; version: string } | null> {
  for (const file of ['.nvmrc', '.node-version']) {
    const text = await readText(join(path, file))
    const version = text ? pinnedNodeVersion(text) : null
    if (version) return { file, version }
  }
  const flockrc = await readText(join(path, '.flockrc'))
  if (flockrc) {
    const m = flockrc.match(/^\s*node\s*=\s*"?(\d+(?:\.\d+){0,2})"?/m)
    if (m) return { file: '.flockrc', version: m[1] }
  }
  return null
}

async function phpExtensions(version: string): Promise<string[]> {
  const out = (await run(`/usr/bin/php${version}`, ['-m'], true)) || ''
  return out.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('[') && !l.includes(' '))
}

/** Extensiones que usa Laravel sin declararlas en composer.json. */
function implicitExtensions(entries: ParsedEnv[]): string[] {
  const out: string[] = []
  const driver = envValue(entries, 'DB_CONNECTION').toLowerCase()
  if (driver === 'mysql' || driver === 'mariadb') out.push('pdo_mysql')
  if (driver === 'pgsql') out.push('pdo_pgsql')
  if (driver === 'sqlite') out.push('pdo_sqlite')
  if (driver === 'sqlsrv') out.push('pdo_sqlsrv')
  if (envValue(entries, 'CACHE_STORE') === 'redis' || envValue(entries, 'SESSION_DRIVER') === 'redis') out.push('redis')
  if (envValue(entries, 'CACHE_STORE') === 'memcached') out.push('memcached')
  if (envValue(entries, 'CACHE_STORE') === 'apc') out.push('apcu')
  if (/imagick/i.test(envValue(entries, 'IMAGE_DRIVER'))) out.push('imagick')
  return out
}

function envEntries(entries: ParsedEnv[]): SiteEnvEntry[] {
  return entries.map((e) => ({
    key: e.key,
    value: e.secret ? '' : e.value,
    secret: e.secret,
    set: e.value !== ''
  }))
}

function databaseOf(entries: ParsedEnv[]): SiteDatabase | null {
  const connection = (envValue(entries, 'DB_CONNECTION') || 'sqlite').toLowerCase()
  if (!['sqlite', 'mysql', 'mariadb', 'pgsql', 'sqlsrv'].includes(connection)) return null
  const port = Number(envValue(entries, 'DB_PORT')) || defaultDatabasePort(connection as DatabaseDriver)
  return {
    connection,
    host: envValue(entries, 'DB_HOST') || '127.0.0.1',
    port,
    database: envValue(entries, 'DB_DATABASE'),
    username: envValue(entries, 'DB_USERNAME'),
    passwordSet: envValue(entries, 'DB_PASSWORD') !== '',
    reachable: null,
    error: ''
  }
}

function mailOf(entries: ParsedEnv[]): SiteMail | null {
  const mailer = envValue(entries, 'MAIL_MAILER')
  if (!mailer) return null
  const rawUsername = envValue(entries, 'MAIL_USERNAME')
  const username = rawUsername === 'null' ? '' : rawUsername
  const mail = {
    mailer,
    host: envValue(entries, 'MAIL_HOST') || '127.0.0.1',
    port: Number(envValue(entries, 'MAIL_PORT')) || MAIL_PORT,
    username,
    encryption: mailEncryptionOf(entries)
  }
  return {
    ...mail,
    passwordSet: envValue(entries, 'MAIL_PASSWORD') !== '' && envValue(entries, 'MAIL_PASSWORD') !== 'null',
    inbox: username ? inboxName(username) : 'default',
    envBlock: mailEnvBlock(mail)
  }
}

/** Prueba la conexión con las credenciales del `.env`, sin exponerlas. */
async function testDatabase(entries: ParsedEnv[], db: SiteDatabase, sitePath: string): Promise<{ reachable: boolean | null; error: string }> {
  if (db.connection === 'sqlite') {
    if (!db.database) return { reachable: null, error: 'DB_DATABASE is empty' }
    const file = db.database.startsWith('/') ? db.database : join(sitePath, db.database)
    return existsSync(file)
      ? { reachable: true, error: '' }
      : { reachable: false, error: `SQLite file not found: ${file}` }
  }
  if (!isSqlDriver(db.connection) || db.connection === 'sqlsrv') {
    return { reachable: null, error: 'Connection test is not available for this driver.' }
  }
  if (!db.username || !db.database) return { reachable: false, error: 'DB_USERNAME or DB_DATABASE is empty' }
  const connection: DatabaseConnection = {
    host: db.host,
    port: db.port,
    database: db.database,
    username: db.username,
    password: envValue(entries, 'DB_PASSWORD')
  }
  const client = await findClient(databaseClientCandidates(db.connection))
  if (!client) return { reachable: null, error: 'The database client is not installed.' }
  const plan = planDatabaseCommand(db.connection as 'mysql' | 'mariadb' | 'pgsql', connection, 'SELECT 1')
  try {
    await runWithEnv(client, plan.args, {
      ...execEnv,
      [plan.envKey]: connection.password
    })
    return { reachable: true, error: '' }
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function findClient(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const path = (await run('which', [candidate], true)).trim()
    if (path) return path
  }
  return null
}

async function latestLog(dir: string): Promise<string | null> {
  const files = await readdir(dir).catch(() => [] as string[])
  const logs = files.filter((f) => f.endsWith('.log'))
  if (!logs.length) return null
  const withTime = await Promise.all(logs.map(async (f) => ({
    file: join(dir, f),
    at: (await stat(join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs
  })))
  withTime.sort((a, b) => b.at - a.at)
  return withTime[0].file
}

async function siteLog(file: string | null, lines = 200): Promise<SiteLog> {
  if (!file) return { text: '', file: null, size: 0 }
  const size = await fileSize(file)
  const text = await tailFile(file)
  const parts = text.split(/\r?\n/)
  return { text: parts.slice(-lines).join('\n'), file, size }
}

export async function getSiteDetail(name: string): Promise<SiteDetail> {
  const site = await findSite(name)
  const domain = await valetDomain()
  const [defaultPhp, installed, isolated, settings, nodeInfo] = await Promise.all([
    defaultPhpVersion(),
    installedPhpVersions(),
    isolatedSites(domain),
    readSiteSettings(name),
    nodeVersionsInfo()
  ])
  const envFile = join(site.path, '.env')
  const envText = (await readText(envFile)) ?? (await readText(join(site.path, '.env.example'))) ?? ''
  const entries = parseEnv(envText)
  const phpVersion = isolated.get(name) ?? defaultPhp
  const nodePin = await pinnedNode(site.path)
  const flockrc = await readText(join(site.path, '.flockrc'))
  const phpPin = flockrc ? pinnedPhpVersion(flockrc) : null
  const nodeVersion = settings.node ?? nodePin?.version ?? nodeInfo.defaultVersion
  const nodeSource = settings.node ? 'isolated' : nodePin ? 'pinned' : 'default'
  const framework = pickFramework({
    artisan: existsSync(join(site.path, 'artisan')),
    composerJson: existsSync(join(site.path, 'composer.json')),
    composerLock: existsSync(join(site.path, 'composer.lock')),
    indexPhp: existsSync(join(site.path, 'index.php')),
    publicIndexPhp: existsSync(join(site.path, 'public', 'index.php'))
  })
  const composer = await readComposer(site.path)
  const enabled = phpVersion ? await phpExtensions(phpVersion) : []
  const required = requiredExtensions(composer)
  const implicit = framework === 'laravel' ? implicitExtensions(entries) : []
  const extensions: SiteExtension[] = [...new Set([...required, ...implicit])]
    .sort()
    .map((ext) => ({
      name: ext,
      required: required.includes(ext),
      enabled: enabled.includes(ext.toLowerCase()),
      source: required.includes(ext) ? 'composer.json' : 'Laravel .env'
    }))

  const database = databaseOf(entries)
  let tested = { reachable: null as boolean | null, error: '' }
  if (database) tested = await testDatabase(entries, database, site.path)

  const queue = await queueState(name, settings.queue)
  const laravelLogFile = await latestLog(join(site.path, 'storage', 'logs'))
  const qLog = queueLogFile(name)

  const warnings: string[] = []
  if (framework === 'laravel' && !existsSync(envFile)) warnings.push('There is no .env file yet. The app uses the defaults, but the panel cannot show its database or mail settings.')
  if (phpVersion && !installed.includes(phpVersion)) warnings.push(`PHP ${phpVersion} is not installed, so the site cannot be served. Install it from the PHP page.`)
  if (isolated.get(name) && !installed.includes(isolated.get(name) as string)) warnings.push(`The isolated PHP ${isolated.get(name)} is missing.`)
  if (database && database.connection !== 'sqlite' && tested.reachable === false) warnings.push('The database is not reachable with the current .env credentials.')
  if (queue.workers > 0 && !queue.systemd) warnings.push('Queue workers are configured but systemd user services are not available in this session.')
  if (queue.workers > 0 && !existsSync(join(site.path, 'artisan'))) warnings.push('Queue workers are configured but this is not a Laravel project.')

  return {
    name: site.name,
    path: site.path,
    url: site.url,
    kind: site.kind,
    secure: site.secure,
    framework,
    laravelVersion: framework === 'laravel' ? await laravelVersion(site.path) : null,
    documentRoot: existsSync(join(site.path, 'public', 'index.php')) ? join(site.path, 'public') : site.path,
    domains: [{ name: `${site.name}.${domain}`, primary: true }],
    php: {
      version: phpVersion,
      source: isolated.has(name) ? 'isolated' : 'default',
      installed,
      isolatedFile: isolated.has(name) ? isolatedSiteConfig(name, domain) : null,
      pinnedFile: phpPin ? '.flockrc' : null,
      pinnedVersion: phpPin
    },
    node: {
      version: nodeVersion,
      source: nodeSource,
      installed: nodeInfo.versions.map((v) => v.version),
      pinnedFile: nodePin?.file ?? null,
      pinnedVersion: nodePin?.version ?? null
    },
    database: database ? { ...database, ...tested } : null,
    mail: mailOf(entries),
    queue,
    env: envEntries(entries),
    composerPhp: composerPhpConstraint(composer),
    extensions,
    logs: {
      laravel: await siteLog(laravelLogFile),
      queue: await siteLog(existsSync(qLog) ? qLog : null)
    },
    warnings
  }
}

export async function updateSiteSettings(name: string, patch: SiteSettingsPatch): Promise<SiteDetail> {
  await findSite(name)
  await writeSiteSettings(name, patch)
  return getSiteDetail(name)
}

/** Copia el `.env` antes de tocarlo; la copia lleva credenciales y va a 0600. */
async function backupEnv(siteName: string, content: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(BACKUPS, stamp, 'env')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${siteName}-env`)
  await writeFile(file, content, { mode: 0o600 })
  await chmod(file, 0o600)
}

export async function setSiteEnv(name: string, changes: EnvWrite[]): Promise<SiteDetail> {
  const site = await findSite(name)
  if (!Array.isArray(changes) || !changes.length) throw new Error('No changes to apply')
  for (const change of changes) {
    if (!change || typeof change.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(change.key)) {
      throw new Error(`Invalid environment key: ${String(change?.key)}`)
    }
    if (change.value !== null && (typeof change.value !== 'string' || change.value.length > 20_000)) {
      throw new Error(`Invalid value for ${change.key}`)
    }
  }
  const file = join(site.path, '.env')
  const existing = (await readText(file)) ?? (await readText(join(site.path, '.env.example'))) ?? ''
  if (await readText(file)) await backupEnv(name, existing)
  const next = applyEnvChanges(existing, changes)
  await writeFile(file, next, { mode: 0o600 })
  await chmod(file, 0o600)
  return getSiteDetail(name)
}

export async function setSiteDatabase(name: string, input: SiteDatabaseInput): Promise<SiteDetail> {
  const site = await findSite(name)
  if (!['sqlite', 'mysql', 'mariadb', 'pgsql', 'sqlsrv'].includes(input.connection)) {
    throw new Error('Unknown database driver')
  }
  const entries = parseEnv((await readText(join(site.path, '.env'))) ?? '')
  const current = envValue(entries, 'DB_PASSWORD')
  const password = input.password === null ? current : input.password

  if (input.connection === 'sqlite') {
    if (!input.database.trim()) throw new Error('Choose the SQLite file path')
    await setSiteEnv(name, [
      { key: 'DB_CONNECTION', value: 'sqlite' },
      { key: 'DB_DATABASE', value: input.database.trim() }
    ])
    return getSiteDetail(name)
  }

  const connection: DatabaseConnection = {
    host: input.host,
    port: input.port,
    database: input.database,
    username: input.username,
    password
  }
  const errors = validateDatabase(connection)
  if (errors.length) throw new Error(errors.join(' '))
  if (input.create) {
    await ensureProjectDatabase(input.connection as 'mysql' | 'mariadb' | 'pgsql', connection)
  }
  await setSiteEnv(name, [
    { key: 'DB_CONNECTION', value: input.connection },
    { key: 'DB_HOST', value: input.host },
    { key: 'DB_PORT', value: String(input.port) },
    { key: 'DB_DATABASE', value: input.database },
    { key: 'DB_USERNAME', value: input.username },
    ...(input.password === null ? [] : [{ key: 'DB_PASSWORD', value: input.password }])
  ])
  return getSiteDetail(name)
}

/** Copia la configuración SMTP del catcher al `.env` del sitio. */
export async function applySiteMail(name: string): Promise<SiteDetail> {
  const site = await findSite(name)
  await configureEnv(site.name)
  return getSiteDetail(name)
}

export async function setSiteMail(name: string, input: SiteMailInput): Promise<SiteDetail> {
  await findSite(name)
  if (!/^[a-z0-9]+$/i.test(input.mailer)) throw new Error('Invalid mailer')
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(input.host)) throw new Error('Invalid mail host')
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('Invalid mail port')
  if (input.username && !/^[A-Za-z0-9._@-]{1,120}$/.test(input.username)) throw new Error('Invalid mail username')
  if (!['', 'none', 'tls', 'ssl'].includes(input.encryption.trim().toLowerCase())) {
    throw new Error('Invalid mail encryption')
  }
  const pair = mailSchemePair(input.encryption)
  const changes: EnvWrite[] = [
    { key: 'MAIL_MAILER', value: input.mailer },
    { key: 'MAIL_HOST', value: input.host },
    { key: 'MAIL_PORT', value: String(input.port) },
    { key: 'MAIL_USERNAME', value: input.username || 'null' },
    // Laravel 11 lee MAIL_SCHEME y Laravel 10 MAIL_ENCRYPTION: se escriben
    // juntos para que el mismo `.env` funcione en ambas versiones.
    { key: 'MAIL_SCHEME', value: pair.scheme },
    { key: 'MAIL_ENCRYPTION', value: pair.encryption }
  ]
  if (input.password !== null) changes.push({ key: 'MAIL_PASSWORD', value: input.password || 'null' })
  await setSiteEnv(name, changes)
  return getSiteDetail(name)
}

/** Fija o quita la versión de PHP del proyecto en `.flockrc` (`php=8.4`). */
export async function pinSitePhp(name: string, version: string | null): Promise<SiteDetail> {
  const site = await findSite(name)
  if (version !== null && !/^\d+\.\d+$/.test(version)) throw new Error('Invalid PHP version')
  const file = join(site.path, '.flockrc')
  const original = await readText(file)
  if (version === null) {
    if (original === null) return getSiteDetail(name)
    const next = original.replace(/^\s*php\s*=.*(?:\r?\n)?/m, '')
    if (next.trim()) await writeFile(file, next, { mode: 0o644 })
    else await unlink(file).catch(() => '')
    return getSiteDetail(name)
  }
  const line = `php=${version}`
  let next: string
  if (original === null) next = `${line}\n`
  else if (/^\s*php\s*=.*$/m.test(original)) next = original.replace(/^\s*php\s*=.*$/m, line)
  else next = `${original.replace(/\n*$/, '\n')}${line}\n`
  await writeFile(file, next, { mode: 0o644 })
  return getSiteDetail(name)
}

export async function openSiteFolder(name: string): Promise<void> {
  const site = await findSite(name)
  const error = await shell.openPath(site.path)
  if (error) throw new Error(error)
}

/** Servidor y puerto del catcher, para los valores iniciales del formulario. */
export async function mailDefaults(): Promise<{ port: number; host: string }> {
  return { port: smtpPort(), host: MAIL_HOST }
}
