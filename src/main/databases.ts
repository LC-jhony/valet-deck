// Bases de datos del equipo: MariaDB/MySQL, PostgreSQL y los archivos SQLite de
// cada sitio. Listar, crear y borrar bases, y probar credenciales.
//
// Las contraseñas se guardan en `~/.valet-studio/databases.json` (0600) o se
// reutilizan las del usuario gestionado de MariaDB. Nunca viajan al renderer.

import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  DatabaseCredentials, DatabaseEngine, DatabaseEntry, DatabaseServer, DatabasesInfo
} from '../shared/site'
import { isSafeDatabaseName, quoteMysqlIdentifier, quotePostgresIdentifier } from './database-setup'
import { env as execEnv, run, runWithEnv } from './exec'
import { readMariaDbCredentials } from './mariadb-setup'
import { listSites } from './valet'
import { parseEnv } from '../shared/site-files'

const HOME = homedir()
const APP = join(HOME, '.valet-studio')
const CREDS_FILE = join(APP, 'databases.json')

interface StoredCredentials {
  host: string
  port: number
  username: string
  password: string
}

type StoredMap = Partial<Record<DatabaseEngine, StoredCredentials>>

async function loadStored(): Promise<StoredMap> {
  try {
    const raw: unknown = JSON.parse(await readFile(CREDS_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw as StoredMap : {}
  } catch { return {} }
}

async function saveStored(map: StoredMap): Promise<void> {
  await mkdir(APP, { recursive: true, mode: 0o700 })
  await writeFile(CREDS_FILE, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 })
  await chmod(CREDS_FILE, 0o600)
}

export async function saveDatabaseCredentials(input: DatabaseCredentials): Promise<void> {
  const engine = input.engine
  if (!['mariadb', 'mysql', 'postgres'].includes(engine)) throw new Error('Unknown database engine')
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(input.host)) throw new Error('Invalid host')
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('Invalid port')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.username)) throw new Error('Invalid user')
  if (typeof input.password !== 'string' || input.password.length > 500) throw new Error('Invalid password')
  const map = await loadStored()
  map[engine] = { host: input.host, port: input.port, username: input.username, password: input.password }
  await saveStored(map)
}

async function credentialsFor(engine: DatabaseEngine): Promise<{ creds: StoredCredentials; managed: boolean } | null> {
  const stored = (await loadStored())[engine]
  if (stored) return { creds: stored, managed: true }
  if (engine === 'mariadb' || engine === 'mysql') {
    const maria = await readMariaDbCredentials()
    if (maria) {
      return {
        creds: { host: maria.host, port: maria.port, username: maria.username, password: maria.password },
        managed: true
      }
    }
    return { creds: { host: '127.0.0.1', port: 3306, username: 'root', password: '' }, managed: false }
  }
  if (engine === 'postgres') {
    return { creds: { host: '127.0.0.1', port: 5432, username: 'postgres', password: '' }, managed: false }
  }
  return null
}

async function clientFor(engine: DatabaseEngine): Promise<string | null> {
  const names = engine === 'postgres'
    ? ['psql']
    : engine === 'mysql'
      ? ['mysql', 'mariadb']
      : ['mariadb', 'mysql']
  for (const name of names) {
    const path = (await run('which', [name], true)).trim()
    // Flock trae sus propios binarios en ~/.local/share/flock/bin: no son la
    // instalación del sistema y no deben hacer parecer que hay un servidor.
    if (path && !path.includes('/.local/share/flock/')) return path
  }
  return null
}

/** ¿dpkg tiene instalado el paquete (o alguno que case con el patrón)? */
async function packageInstalled(pattern: string): Promise<boolean> {
  const out = await run('dpkg-query', ['-W', '-f=${Package} ${Status}\n', pattern], true)
  return out.split('\n').some((line) => / install ok installed$/.test(line.trim()))
}

async function unitKnown(unit: string): Promise<boolean> {
  const out = await run('systemctl', ['list-unit-files', '--no-legend', `${unit}.service`, '--no-pager'], true)
  return out.trim() !== ''
}

/** Unidad real del motor: MySQL puede llamarse `mysql` o `mysqld`. */
async function serviceUnit(engine: DatabaseEngine): Promise<string> {
  const candidates = engine === 'postgres' ? ['postgresql'] : engine === 'mysql' ? ['mysql', 'mysqld'] : ['mariadb']
  for (const unit of candidates) if (await unitKnown(unit)) return unit
  return candidates[0]
}

/**
 * El servidor, no el cliente. MariaDB trae `mariadb` y MySQL también puede
 * hablar con ese cliente; PostgreSQL aparece en el PATH de Flock. Sin esta
 * comprobación el panel enseñaba «MySQL is not running» en equipos donde solo
 * había un cliente instalado.
 */
async function serverInstalled(engine: DatabaseEngine, unit: string): Promise<boolean> {
  if (await unitKnown(unit)) return true
  const patterns = engine === 'postgres'
    ? ['postgresql', 'postgresql-[0-9]*']
    : engine === 'mysql'
      ? ['mysql-server*']
      : ['mariadb-server*']
  for (const pattern of patterns) if (await packageInstalled(pattern)) return true
  return false
}

function mysqlArgs(creds: StoredCredentials, sql: string, database?: string): string[] {
  return [
    '--protocol=tcp',
    `-h${creds.host}`,
    `-P${creds.port}`,
    `-u${creds.username}`,
    '--batch',
    '--skip-column-names',
    ...(database ? [database] : []),
    '-e', sql
  ]
}

function psqlArgs(creds: StoredCredentials, sql: string, database = 'postgres'): string[] {
  return [
    '-h', creds.host,
    '-p', String(creds.port),
    '-U', creds.username,
    '-d', database,
    '-tAc', sql
  ]
}

async function runSql(
  engine: DatabaseEngine, client: string, creds: StoredCredentials, sql: string, database?: string
): Promise<string> {
  const args = engine === 'postgres' ? psqlArgs(creds, sql, database) : mysqlArgs(creds, sql, database)
  const env = engine === 'postgres'
    ? { ...execEnv, PGPASSWORD: creds.password }
    : { ...execEnv, MYSQL_PWD: creds.password }
  return runWithEnv(client, args, env)
}

const SYSTEM_DATABASES = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])

async function mysqlDatabases(client: string, creds: StoredCredentials, engine: DatabaseEngine): Promise<DatabaseEntry[]> {
  const sql = [
    'SELECT s.SCHEMA_NAME, COALESCE(s.DEFAULT_CHARACTER_SET_NAME, \'\'),',
    'COALESCE(t.tables, 0), COALESCE(t.size, 0)',
    'FROM information_schema.SCHEMATA s',
    'LEFT JOIN (SELECT TABLE_SCHEMA, COUNT(*) AS tables,',
    'SUM(DATA_LENGTH + INDEX_LENGTH) AS size FROM information_schema.TABLES',
    'GROUP BY TABLE_SCHEMA) t ON t.TABLE_SCHEMA = s.SCHEMA_NAME',
    'ORDER BY s.SCHEMA_NAME'
  ].join(' ')
  const out = await runSql(engine, client, creds, sql)
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, charset, tables, size] = line.split('\t')
    return {
      name,
      engine,
      size: Number(size) || 0,
      tables: Number(tables) || 0,
      charset: charset ?? '',
      sites: [] as string[]
    }
  }).filter((db) => db.name && !SYSTEM_DATABASES.has(db.name))
}

async function postgresDatabases(client: string, creds: StoredCredentials): Promise<DatabaseEntry[]> {
  const sql = 'SELECT datname, pg_database_size(datname) FROM pg_database WHERE datistemplate = false ORDER BY datname'
  const out = await runSql('postgres', client, creds, sql)
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, size] = line.split('|')
    return {
      name,
      engine: 'postgres' as const,
      size: Number(size) || 0,
      tables: null,
      charset: 'UTF8',
      sites: [] as string[]
    }
  })
}

function versionOf(out: string): string | null {
  const m = out.match(/(\d+\.\d+(?:\.\d+)?)/)
  return m ? m[1] : null
}

async function serverInfo(engine: DatabaseEngine): Promise<DatabaseServer> {
  const label = engine === 'postgres' ? 'PostgreSQL' : engine === 'mysql' ? 'MySQL' : 'MariaDB'
  const service = await serviceUnit(engine)
  const unitActive = (await run('systemctl', ['is-active', service], true)).trim() === 'active'
  const port = engine === 'postgres' ? 5432 : 3306
  const base = { engine, label, port, host: '127.0.0.1', service }
  if (!(await serverInstalled(engine, service))) {
    return {
      ...base, installed: false, active: false, version: null, username: '',
      managed: false, databases: [], error: ''
    }
  }
  const client = await clientFor(engine)
  if (!client) {
    return {
      ...base, installed: true, active: unitActive, version: null, username: '',
      managed: false, databases: [],
      error: `The ${label} command-line client is not installed, so the panel cannot list its databases.`
    }
  }
  const versionOut = (await run(client, ['--version'], true)).trim()
  const found = await credentialsFor(engine)
  if (!found) {
    return {
      ...base, installed: true, active: unitActive, version: versionOf(versionOut), username: '',
      managed: false, databases: [], error: 'No credentials configured.'
    }
  }
  const { creds, managed } = found
  let databases: DatabaseEntry[] = []
  let error = ''
  if (!unitActive) {
    error = `${label} is installed but stopped. Start it to list and create databases.`
  } else {
    try {
      databases = engine === 'postgres'
        ? await postgresDatabases(client, creds)
        : await mysqlDatabases(client, creds, engine)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }
  return {
    ...base, installed: true, active: unitActive, version: versionOf(versionOut),
    port: creds.port, host: creds.host, username: creds.username,
    managed, databases, error
  }
}

/** Bases SQLite de cada proyecto, detectadas por `.env` y por `database/*.sqlite`. */
async function sqliteDatabases(): Promise<{ file: string; site: string; size: number }[]> {
  const out: { file: string; site: string; size: number }[] = []
  const sites = await listSites()
  for (const site of sites) {
    const envFile = join(site.path, '.env')
    if (!existsSync(envFile)) continue
    const entries = parseEnv(await readFile(envFile, 'utf8').catch(() => ''))
    if (entries.find((e) => e.key === 'DB_CONNECTION')?.value !== 'sqlite') continue
    const value = entries.find((e) => e.key === 'DB_DATABASE')?.value ?? ''
    const candidates = value
      ? [value.startsWith('/') ? value : join(site.path, value)]
      : [join(site.path, 'database', 'database.sqlite')]
    for (const file of candidates) {
      if (!file.endsWith('.sqlite') && !file.endsWith('.db')) continue
      if (!existsSync(file)) continue
      const size = (await stat(file).catch(() => ({ size: 0 }))).size
      if (!out.some((s) => s.file === file)) out.push({ file, site: site.name, size })
    }
  }
  return out.sort((a, b) => a.site.localeCompare(b.site))
}

export async function databasesInfo(): Promise<DatabasesInfo> {
  const servers = await Promise.all([
    serverInfo('mariadb'),
    serverInfo('mysql'),
    serverInfo('postgres')
  ])
  return { servers, sqlite: await sqliteDatabases() }
}

export async function createDatabase(engine: DatabaseEngine, name: string): Promise<void> {
  if (!isSafeDatabaseName(name)) throw new Error('Invalid database name')
  if (engine === 'sqlite') throw new Error('SQLite databases are created by the project itself.')
  const client = await clientFor(engine)
  if (!client) throw new Error('The database client is not installed.')
  const found = await credentialsFor(engine)
  if (!found) throw new Error('No credentials configured.')
  const sql = engine === 'postgres'
    ? `CREATE DATABASE ${quotePostgresIdentifier(name)}`
    : `CREATE DATABASE IF NOT EXISTS ${quoteMysqlIdentifier(name)}`
  await runSql(engine, client, found.creds, sql)
}

export async function dropDatabase(engine: DatabaseEngine, name: string): Promise<void> {
  if (!isSafeDatabaseName(name)) throw new Error('Invalid database name')
  if (engine === 'sqlite') throw new Error('Delete the SQLite file from the project instead.')
  if (SYSTEM_DATABASES.has(name) || name === 'postgres') throw new Error('That database is reserved and cannot be dropped.')
  const client = await clientFor(engine)
  if (!client) throw new Error('The database client is not installed.')
  const found = await credentialsFor(engine)
  if (!found) throw new Error('No credentials configured.')
  const sql = engine === 'postgres'
    ? `DROP DATABASE ${quotePostgresIdentifier(name)}`
    : `DROP DATABASE ${quoteMysqlIdentifier(name)}`
  await runSql(engine, client, found.creds, sql)
}

export async function testDatabaseConnection(input: DatabaseCredentials): Promise<string> {
  const client = await clientFor(input.engine)
  if (!client) throw new Error('The database client is not installed.')
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(input.host)) throw new Error('Invalid host')
  const creds: StoredCredentials = {
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password
  }
  const out = await runSql(input.engine, client, creds, 'SELECT 1', input.engine === 'postgres' ? 'postgres' : undefined)
  return out.trim() || 'OK'
}
