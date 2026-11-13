import { describe, expect, it } from 'vitest'
import { DATABASE_GUIDES, databaseEnv, databaseGuide } from './database-guides'

const server = { host: '127.0.0.1', port: 3306, username: 'valet_studio' }

describe('guías de bases de datos', () => {
  it('cubre los cuatro motores con pasos para apt, dnf y pacman', () => {
    for (const engine of ['mariadb', 'mysql', 'postgres', 'sqlite'] as const) {
      const guide = databaseGuide(engine)
      expect(guide.engine).toBe(engine)
      for (const pm of ['apt', 'dnf', 'pacman'] as const) {
        expect(guide.steps[pm].length).toBeGreaterThan(0)
        expect(guide.steps[pm].every((step) => step.commands.length > 0)).toBe(true)
      }
    }
  })

  it('usa el paquete y la unidad reales de cada gestor', () => {
    expect(databaseGuide('mariadb').steps.apt[0].commands.join('\n')).toContain('mariadb-server')
    expect(databaseGuide('mariadb').service).toBe('mariadb')
    expect(databaseGuide('mysql').steps.dnf[1].commands).toContain('sudo systemctl enable --now mysqld')
    expect(databaseGuide('postgres').steps.apt[0].commands.join('\n')).toContain('php8.5-pgsql')
    expect(databaseGuide('sqlite').service).toBeNull()
  })

  it('explica que PostgreSQL necesita pdo_pgsql y SQLite no tiene servidor', () => {
    expect(databaseGuide('postgres').notes.join(' ')).toContain('pdo_pgsql')
    expect(databaseGuide('sqlite').steps.apt[0].commands[0]).toContain('php8.5-sqlite3')
    expect(DATABASE_GUIDES.sqlite.summary).toContain('no server')
  })
})

describe('bloque .env de Laravel', () => {
  it('usa los datos del servidor y una contraseña marcadora', () => {
    expect(databaseEnv('mariadb', server)).toEqual([
      'DB_CONNECTION=mysql',
      'DB_HOST=127.0.0.1',
      'DB_PORT=3306',
      'DB_DATABASE=my_app',
      'DB_USERNAME=valet_studio',
      'DB_PASSWORD=change-me'
    ])
  })

  it('cambia a pgsql y al puerto 5432 en PostgreSQL', () => {
    const lines = databaseEnv('postgres', { host: '127.0.0.1', port: 5432, username: 'valet_studio' })
    expect(lines).toContain('DB_CONNECTION=pgsql')
    expect(lines).toContain('DB_PORT=5432')
  })

  it('usa valores seguros cuando el servidor aún no tiene credenciales', () => {
    const lines = databaseEnv('mysql', null)
    expect(lines).toContain('DB_HOST=127.0.0.1')
    expect(lines).toContain('DB_PORT=3306')
    expect(lines).toContain('DB_USERNAME=root')
  })

  it('describe SQLite sin host, puerto ni usuario', () => {
    expect(databaseEnv('sqlite', null, 'my_app')).toEqual([
      'DB_CONNECTION=sqlite',
      'DB_DATABASE=/absolute/path/to/my_app.sqlite'
    ])
  })
})
