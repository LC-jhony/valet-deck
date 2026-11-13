import { describe, expect, it } from 'vitest'
import {
  applyEnvChanges, compareVersions, envValue, inboxName, isSecretKey,
  isolatedPhpVersion, isolatedSiteName, mailEncryptionOf, mailEnvBlock, mailSchemePair, majorVersion,
  parseEnv, pickFramework, pinnedNodeVersion, pinnedPhpVersion
} from './site-files'

describe('parseEnv', () => {
  it('lee claves, ignora comentarios y quita comillas', () => {
    const out = parseEnv([
      'APP_NAME="Valet Deck"',
      '# comentario',
      '',
      "DB_PASSWORD='s3creto'",
      'MAIL_MAILER=smtp',
      'sin_igual'
    ].join('\n'))
    expect(out).toEqual([
      { key: 'APP_NAME', value: 'Valet Deck', secret: false },
      { key: 'DB_PASSWORD', value: 's3creto', secret: true },
      { key: 'MAIL_MAILER', value: 'smtp', secret: false }
    ])
  })

  it('envValue devuelve la cadena vacía si falta', () => {
    expect(envValue(parseEnv('A=1'), 'B')).toBe('')
  })
})

describe('isSecretKey', () => {
  it('reconoce contraseñas, claves y tokens', () => {
    expect(isSecretKey('DB_PASSWORD')).toBe(true)
    expect(isSecretKey('APP_KEY')).toBe(true)
    expect(isSecretKey('MAIL_PASSWORD')).toBe(true)
    expect(isSecretKey('AWS_SECRET_ACCESS_KEY')).toBe(true)
    expect(isSecretKey('MAIL_USERNAME')).toBe(false)
  })
})

describe('applyEnvChanges', () => {
  it('actualiza y añade claves sin tocar el resto', () => {
    const out = applyEnvChanges('APP_NAME=Demo\nDB_HOST=127.0.0.1\n', [
      { key: 'DB_HOST', value: 'localhost' },
      { key: 'DB_PORT', value: '3307' }
    ])
    expect(out).toContain('APP_NAME=Demo')
    expect(out).toContain('DB_HOST=localhost')
    expect(out).toContain('DB_PORT=3307')
  })

  it('elimina una clave y su salto de línea', () => {
    const out = applyEnvChanges('A=1\nB=2\nC=3\n', [{ key: 'B', value: null }])
    expect(out).toBe('A=1\nC=3\n')
  })

  it('descomenta una clave que Laravel dejó comentada', () => {
    const out = applyEnvChanges('# DB_PORT=3306\n', [{ key: 'DB_PORT', value: '3307' }])
    expect(out).toBe('DB_PORT=3307\n')
  })
})

describe('pinnedNodeVersion', () => {
  it('acepta versiones con o sin v y rechaza alias', () => {
    expect(pinnedNodeVersion('22\n')).toBe('22')
    expect(pinnedNodeVersion('v20.11.1')).toBe('20.11.1')
    expect(pinnedNodeVersion('lts/*')).toBeNull()
    expect(pinnedNodeVersion('# comentario\n18')).toBe('18')
  })
})

describe('pinnedPhpVersion', () => {
  it('lee php= de .flockrc', () => {
    expect(pinnedPhpVersion('# proyecto\nphp=8.4\nnode=22\n')).toBe('8.4')
    expect(pinnedPhpVersion('php = "8.5"')).toBe('8.5')
    expect(pinnedPhpVersion('php=8.4 # project pin\n')).toBe('8.4')
    expect(pinnedPhpVersion('node=22')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('ordena numéricamente y no como texto', () => {
    expect(compareVersions('8.10', '8.9')).toBeGreaterThan(0)
    expect(compareVersions('8.5', '8.5')).toBe(0)
    expect(compareVersions('7.4', '8.1')).toBeLessThan(0)
  })
})

describe('pickFramework', () => {
  it('detecta Laravel, PHP y estático', () => {
    expect(pickFramework({ artisan: true, composerJson: true, composerLock: true, indexPhp: false, publicIndexPhp: true })).toBe('laravel')
    expect(pickFramework({ artisan: false, composerJson: true, composerLock: false, indexPhp: false, publicIndexPhp: true })).toBe('php')
    expect(pickFramework({ artisan: false, composerJson: false, composerLock: false, indexPhp: false, publicIndexPhp: false })).toBe('static')
  })
})

describe('isolatedPhpVersion', () => {
  it('lee la marca que escribe valet isolate', () => {
    expect(isolatedPhpVersion('# ISOLATED_PHP_VERSION=8.4\nserver {}\n')).toBe('8.4')
    expect(isolatedPhpVersion('server {}')).toBeNull()
  })
})

describe('isolatedSiteName', () => {
  it('entiende el archivo de Valet Linux con y sin .conf', () => {
    expect(isolatedSiteName('my-app.test', 'test')).toBe('my-app')
    expect(isolatedSiteName('my-app.test.conf', 'test')).toBe('my-app')
    expect(isolatedSiteName('my-app.conf', 'test')).toBeNull()
    expect(isolatedSiteName('.keep', 'test')).toBeNull()
  })
})

describe('majorVersion e inboxName', () => {
  it('normaliza la mayor y el nombre de la bandeja', () => {
    expect(majorVersion('v22.11.0')).toBe('22')
    expect(majorVersion('lts')).toBe('')
    expect(inboxName('Mi App_2')).toBe('mi-app_2')
  })
})

describe('mailSchemePair y mailEncryptionOf', () => {
  it('escribe el par coherente para Laravel 10 y 11', () => {
    expect(mailSchemePair('')).toEqual({ scheme: 'null', encryption: 'null' })
    expect(mailSchemePair('none')).toEqual({ scheme: 'null', encryption: 'null' })
    expect(mailSchemePair('tls')).toEqual({ scheme: 'smtp', encryption: 'tls' })
    expect(mailSchemePair('ssl')).toEqual({ scheme: 'smtps', encryption: 'ssl' })
  })

  it('normaliza null y prioriza MAIL_SCHEME', () => {
    expect(mailEncryptionOf(parseEnv('MAIL_SCHEME=null\nMAIL_ENCRYPTION=null'))).toBe('')
    expect(mailEncryptionOf(parseEnv('MAIL_SCHEME=smtp\nMAIL_ENCRYPTION=tls'))).toBe('tls')
    expect(mailEncryptionOf(parseEnv('MAIL_SCHEME=smtps\nMAIL_ENCRYPTION=null'))).toBe('ssl')
    expect(mailEncryptionOf(parseEnv('MAIL_ENCRYPTION=ssl'))).toBe('ssl')
    expect(mailEncryptionOf(parseEnv('MAIL_ENCRYPTION=tls'))).toBe('tls')
  })
})

describe('mailEnvBlock', () => {
  it('genera un bloque copiable con scheme y encryption sincronizados', () => {
    expect(mailEnvBlock({
      mailer: 'smtp', host: '127.0.0.1', port: 1025, username: 'mi-app', encryption: ''
    })).toBe([
      'MAIL_MAILER=smtp',
      'MAIL_HOST=127.0.0.1',
      'MAIL_PORT=1025',
      'MAIL_USERNAME=mi-app',
      'MAIL_PASSWORD=null',
      'MAIL_SCHEME=null',
      'MAIL_ENCRYPTION=null'
    ].join('\n'))
    expect(mailEnvBlock({
      mailer: 'smtp', host: '127.0.0.1', port: 1025, username: 'mi-app', encryption: 'ssl'
    })).toContain('MAIL_SCHEME=smtps\nMAIL_ENCRYPTION=ssl')
  })
})
