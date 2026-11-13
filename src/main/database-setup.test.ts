import { describe, expect, it } from 'vitest'
import {
  buildMysqlCreateDatabaseSql, buildMysqlDatabaseExistsSql, buildPostgresCreateDatabaseSql,
  buildPostgresDatabaseExistsSql, databaseClientCandidates, ensureProjectDatabase,
  isSafeDatabaseName, planDatabaseCommand, quoteMysqlIdentifier, quotePostgresIdentifier
} from './database-setup'

const connection = {
  host: '127.0.0.1', port: 3306, database: 'mi-app', username: 'valet_studio', password: 'Secreto-largo_1234567890-abc'
}

describe('nombres de base de datos', () => {
  it('acepta letras, números, guiones y guiones bajos', () => {
    for (const name of ['laravel', 'mi-app', 'mi_app_2', 'A1']) {
      expect(isSafeDatabaseName(name)).toBe(true)
    }
  })

  it('rechaza espacios, comillas y nombres que empiezan por guion', () => {
    for (const name of ['', 'mi app', 'app`; DROP', "app'", 'app"', '-app', 'a'.repeat(64)]) {
      expect(isSafeDatabaseName(name)).toBe(false)
    }
  })

  it('cita el identificador con el delimitador de cada motor', () => {
    expect(quoteMysqlIdentifier('mi-app')).toBe('`mi-app`')
    expect(quotePostgresIdentifier('mi-app')).toBe('"mi-app"')
    expect(() => quoteMysqlIdentifier('mi`app')).toThrow(/only allows/)
  })
})

describe('SQL de creación', () => {
  it('crea la base solo si no existe y sin tocar otras', () => {
    expect(buildMysqlCreateDatabaseSql('mi-app')).toBe('CREATE DATABASE IF NOT EXISTS `mi-app`;')
    expect(buildPostgresCreateDatabaseSql('mi-app')).toBe('CREATE DATABASE "mi-app";')
    expect(buildMysqlCreateDatabaseSql('mi-app')).not.toMatch(/DROP|ALTER|GRANT/i)
  })

  it('comprueba la existencia por el catálogo, sin listar otras bases', () => {
    expect(buildMysqlDatabaseExistsSql('mi-app'))
      .toBe("SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = 'mi-app';")
    expect(buildPostgresDatabaseExistsSql('mi-app'))
      .toBe("SELECT 1 FROM pg_database WHERE datname = 'mi-app';")
  })
})

describe('clientes por motor', () => {
  it('prefiere el cliente de MariaDB y cae a mysql', () => {
    expect(databaseClientCandidates('mariadb')).toEqual(['mariadb', 'mysql'])
    expect(databaseClientCandidates('mysql')).toEqual(['mariadb', 'mysql'])
  })

  it('usa psql para PostgreSQL y nada para SQLite/SQL Server', () => {
    expect(databaseClientCandidates('pgsql')).toEqual(['psql'])
    expect(databaseClientCandidates('sqlite')).toEqual([])
    expect(databaseClientCandidates('sqlsrv')).toEqual([])
  })
})

describe('plan del comando SQL', () => {
  it('conecta por TCP con el cliente de MariaDB y lee la contraseña de MYSQL_PWD', () => {
    const plan = planDatabaseCommand('mariadb', connection, buildMysqlDatabaseExistsSql('mi-app'))
    expect(plan.envKey).toBe('MYSQL_PWD')
    expect(plan.args).toEqual(expect.arrayContaining([
      '--protocol=tcp', '-h127.0.0.1', '-P3306', '-uvalet_studio', '--batch', '--skip-column-names'
    ]))
  })

  it('usa PGPASSWORD y la base postgres para las consultas de administración', () => {
    const plan = planDatabaseCommand('pgsql', { ...connection, port: 5432 }, buildPostgresDatabaseExistsSql('mi-app'))
    expect(plan.envKey).toBe('PGPASSWORD')
    expect(plan.args).toEqual(expect.arrayContaining(['-h', '127.0.0.1', '-p', '5432', '-U', 'valet_studio', '-d', 'postgres']))
  })

  it('nunca pone la contraseña en los argumentos', () => {
    for (const driver of ['mysql', 'mariadb', 'pgsql'] as const) {
      const plan = planDatabaseCommand(driver, connection, 'SELECT 1;')
      expect(plan.args.join(' ')).not.toContain(connection.password)
    }
  })
})

describe('garantía de base por proyecto', () => {
  it('no hace nada con SQLite ni con SQL Server', async () => {
    const logs: string[] = []
    await expect(ensureProjectDatabase('sqlite', null, (text) => logs.push(text))).resolves.toBe(true)
    await expect(ensureProjectDatabase('sqlsrv', {
      host: '127.0.0.1', port: 1433, database: 'mi-app', username: 'sa', password: 'x'
    }, (text) => logs.push(text))).resolves.toBe(true)
    expect(logs).toEqual([])
  })
})
