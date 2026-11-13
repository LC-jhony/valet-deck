// Base de datos por proyecto, como Flock: antes de `artisan migrate` la base
// debe existir. Se crea de forma idempotente (`IF NOT EXISTS`) con las mismas
// credenciales que el proyecto usará después. No se copian datos, no se borra
// ninguna base y no se tocan otras bases del servidor.
//
// La contraseña viaja por el entorno (`MYSQL_PWD`/`PGPASSWORD`), nunca por los
// argumentos: `ps` no debe poder leerla.

import { DATABASE_NAME_RE, type DatabaseConnection, type DatabaseDriver } from '../shared/laravel'
import { env, run, runWithEnv } from './exec'

/** Mismo alfabeto que Flock y que el límite de PostgreSQL (63 caracteres). */
export function isSafeDatabaseName(name: string): boolean {
  return DATABASE_NAME_RE.test(name)
}

function assertSafeName(name: string): void {
  if (!isSafeDatabaseName(name)) {
    throw new Error('The database name only allows letters, numbers, hyphens and underscores (max. 63).')
  }
}

/** Identificador de MySQL/MariaDB entre backticks. */
export function quoteMysqlIdentifier(name: string): string {
  assertSafeName(name)
  return `\`${name}\``
}

/** Identificador de PostgreSQL entre comillas dobles. */
export function quotePostgresIdentifier(name: string): string {
  assertSafeName(name)
  return `"${name}"`
}

export function buildMysqlDatabaseExistsSql(name: string): string {
  assertSafeName(name)
  return `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '${name}';`
}

export function buildMysqlCreateDatabaseSql(name: string): string {
  return `CREATE DATABASE IF NOT EXISTS ${quoteMysqlIdentifier(name)};`
}

export function buildPostgresDatabaseExistsSql(name: string): string {
  assertSafeName(name)
  return `SELECT 1 FROM pg_database WHERE datname = '${name}';`
}

export function buildPostgresCreateDatabaseSql(name: string): string {
  return `CREATE DATABASE ${quotePostgresIdentifier(name)};`
}

/** Clientes que se prueban, en orden, para cada motor. */
export function databaseClientCandidates(driver: DatabaseDriver): string[] {
  if (driver === 'mysql' || driver === 'mariadb') return ['mariadb', 'mysql']
  if (driver === 'pgsql') return ['psql']
  return []
}

async function findClient(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const path = (await run('which', [candidate], true)).trim()
    if (path !== '') return path
  }
  return null
}

const mysqlArgs = (connection: DatabaseConnection, sql: string): string[] => [
  '--protocol=tcp',
  `-h${connection.host.trim()}`,
  `-P${connection.port}`,
  `-u${connection.username.trim()}`,
  '--batch',
  '--skip-column-names',
  '-e',
  sql
]

const postgresArgs = (connection: DatabaseConnection, sql: string): string[] => [
  '-h', connection.host.trim(),
  '-p', String(connection.port),
  '-U', connection.username.trim(),
  '-d', 'postgres',
  '-tAc', sql
]

export type SqlDatabaseDriver = 'mysql' | 'mariadb' | 'pgsql'

export interface DatabaseCommandPlan {
  args: string[]
  /** Variable de entorno por la que viaja la contraseña. */
  envKey: 'MYSQL_PWD' | 'PGPASSWORD'
}

/** Argumentos del cliente; la contraseña nunca aparece aquí, solo en `envKey`. */
export function planDatabaseCommand(
  driver: SqlDatabaseDriver, connection: DatabaseConnection, sql: string
): DatabaseCommandPlan {
  if (driver === 'pgsql') {
    return { args: postgresArgs(connection, sql), envKey: 'PGPASSWORD' }
  }
  return { args: mysqlArgs(connection, sql), envKey: 'MYSQL_PWD' }
}

/**
 * Garantiza que la base del proyecto existe. SQLite y SQL Server no necesitan
 * nada. Devuelve `false` solo cuando PostgreSQL no se pudo comprobar porque
 * falta `psql`: el proyecto sigue y la persona crea la base a mano.
 */
export async function ensureProjectDatabase(
  driver: DatabaseDriver,
  connection: DatabaseConnection | null,
  log: (text: string) => void = () => {}
): Promise<boolean> {
  if (driver === 'sqlite' || driver === 'sqlsrv' || !connection) return true
  assertSafeName(connection.database)

  const client = await findClient(databaseClientCandidates(driver))
  if (!client) {
    if (driver === 'pgsql') {
      log('psql is not installed: create the PostgreSQL database by hand before running the migrations.\n')
      return false
    }
    throw new Error('The MariaDB/MySQL client is missing: install mariadb-client or mysql-client.')
  }

  const sqlDriver: SqlDatabaseDriver = driver
  const existsSql = driver === 'pgsql'
    ? buildPostgresDatabaseExistsSql(connection.database)
    : buildMysqlDatabaseExistsSql(connection.database)
  const createSql = driver === 'pgsql'
    ? buildPostgresCreateDatabaseSql(connection.database)
    : buildMysqlCreateDatabaseSql(connection.database)
  // Lo que devuelve cada cliente cuando la base ya existe.
  const found = driver === 'pgsql' ? '1' : connection.database

  const existsPlan = planDatabaseCommand(sqlDriver, connection, existsSql)
  const createPlan = planDatabaseCommand(sqlDriver, connection, createSql)
  const childEnv = { ...env, [existsPlan.envKey]: connection.password }

  try {
    const result = (await runWithEnv(client, existsPlan.args, childEnv)).trim()
    if (result === found) {
      log(`Database ${connection.database} already exists.\n`)
      return true
    }
    await runWithEnv(client, createPlan.args, childEnv)
  } catch (e) {
    // Otra ejecución (o un hilo del instalador) pudo crearla entre la
    // comprobación y el CREATE: la base existe, que es lo que se busca.
    if (/already exists|database exists/i.test((e as Error).message)) {
      log(`Database ${connection.database} already exists.\n`)
      return true
    }
    throw new Error(
      `Could not create the database ${connection.database}: ${(e as Error).message}. ` +
      'Check the credentials or create it by hand.'
    )
  }
  log(`Database ${connection.database} created.\n`)
  return true
}
