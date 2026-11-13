import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MARIADB_DATA_DIR, MARIADB_HOST, MARIADB_PORT, MARIADB_USER,
  bindAddressWarning, buildMariaDbPrepareSql, foreignMariaDbReason, generateMariaDbPassword,
  isTransientMariaDbError, mariaDbRootError, parseBindAddress, parseMariaDbCredentials, planMariaDbCredentials,
  retryTransient, waitUntil, writeFileAtomic
} from './mariadb-setup'

describe('SQL de preparación de MariaDB', () => {
  const password = 'Abcdef_-0123456789abcdef_-01'
  const sql = buildMariaDbPrepareSql(password)

  it('crea el usuario gestionado en localhost y 127.0.0.1', () => {
    expect(sql).toContain(`CREATE USER IF NOT EXISTS '${MARIADB_USER}'@'localhost'`)
    expect(sql).toContain(`CREATE USER IF NOT EXISTS '${MARIADB_USER}'@'127.0.0.1'`)
    expect(sql).toContain(`ALTER USER '${MARIADB_USER}'@'localhost' IDENTIFIED BY '${password}'`)
    expect(sql).toContain(`GRANT ALL PRIVILEGES ON *.* TO '${MARIADB_USER}'@'localhost'`)
    expect(sql).toContain('FLUSH PRIVILEGES;')
  })

  it('no ejecuta el secure: nada de anónimos, test, root remoto ni DROP', () => {
    expect(sql).not.toMatch(/DROP\s+(DATABASE|USER)/i)
    expect(sql).not.toMatch(/DELETE\s+FROM\s+mysql\./i)
    expect(sql).not.toMatch(/\broot\b/i)
    expect(sql).not.toContain('test')
    expect(sql).not.toMatch(/WITH\s+GRANT\s+OPTION/i)
  })

  it('pide la dirección de escucha en la misma elevación', () => {
    expect(sql).toContain('SELECT @@bind_address;')
  })

  it('pasa la contraseña por comillas simples sin huecos de inyección', () => {
    expect(sql.match(/IDENTIFIED BY/g)?.length).toBe(4) // 2 usuarios x CREATE + ALTER
    expect(() => buildMariaDbPrepareSql("x'); DROP TABLE mysql.user;--")).toThrow(/Invalid generated/)
    expect(() => buildMariaDbPrepareSql('corto')).toThrow(/Invalid generated/)
  })
})

describe('contraseña generada', () => {
  it('encaja en el alfabeto que acepta el SQL y no se repite a corto plazo', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const password = generateMariaDbPassword()
      expect(password).toMatch(/^[A-Za-z0-9_-]{24,128}$/)
      expect(seen.has(password)).toBe(false)
      seen.add(password)
      expect(() => buildMariaDbPrepareSql(password)).not.toThrow()
    }
  })
})

describe('plan de credenciales', () => {
  it('genera contraseña solo en la primera instalación', () => {
    const first = planMariaDbCredentials(null)
    expect(first.generated).toBe(true)
    expect(first.credentials).toMatchObject({
      host: MARIADB_HOST, port: MARIADB_PORT, username: MARIADB_USER
    })
    expect(first.credentials.password).toMatch(/^[A-Za-z0-9_-]{24,128}$/)
  })

  it('reutiliza la contraseña guardada aunque la conexión falle: no rota nada', () => {
    const existing = {
      host: 'otro-host', port: 3307, username: 'otro', password: 'contraseña-guardada-larga-1'
    }
    const plan = planMariaDbCredentials(existing)
    expect(plan.generated).toBe(false)
    expect(plan.credentials.password).toBe(existing.password)
    // El usuario gestionado siempre es el mismo; solo la contraseña se conserva.
    expect(plan.credentials.username).toBe(MARIADB_USER)
    expect(plan.credentials.host).toBe(MARIADB_HOST)
  })
})

describe('conflicto con MySQL/MariaDB ajeno', () => {
  it('deja seguir si MariaDB ya está instalada', () => {
    expect(foreignMariaDbReason({ mariadbServer: true, mysqlServer: true, dataDirInitialized: true })).toBeNull()
  })

  it('se detiene ante un servidor MySQL', () => {
    expect(foreignMariaDbReason({ mariadbServer: false, mysqlServer: true, dataDirInitialized: false }))
      .toContain('MySQL server')
  })

  it('se detiene ante un directorio de datos ya inicializado', () => {
    expect(foreignMariaDbReason({ mariadbServer: false, mysqlServer: false, dataDirInitialized: true }))
      .toContain(MARIADB_DATA_DIR)
  })

  it('permite instalar en limpio', () => {
    expect(foreignMariaDbReason({ mariadbServer: false, mysqlServer: false, dataDirInitialized: false })).toBeNull()
  })
})

describe('dirección de escucha', () => {
  it('avisa si MariaDB queda expuesta en todas las interfaces', () => {
    for (const address of ['0.0.0.0', '::', '*']) {
      expect(bindAddressWarning(address)).toContain('bind-address = 127.0.0.1')
    }
  })

  it('no avisa en loopback ni sin dato', () => {
    expect(bindAddressWarning('127.0.0.1')).toBeNull()
    expect(bindAddressWarning('::1')).toBeNull()
    expect(bindAddressWarning('')).toBeNull()
    expect(bindAddressWarning(null)).toBeNull()
  })

  it('lee la última línea de la salida del SQL', () => {
    expect(parseBindAddress('\n\n127.0.0.1\n')).toBe('127.0.0.1')
    expect(parseBindAddress('')).toBeNull()
  })
})

describe('error de acceso como root', () => {
  it('distingue una contraseña de root puesta a mano', () => {
    const message = mariaDbRootError('ERROR 1045 (28000): Access denied for user root@localhost')
    expect(message).toContain('root')
    expect(message).toContain('sudo mariadb')
    expect(message).toContain('manual')
  })

  it('distingue el servicio parado', () => {
    expect(mariaDbRootError("ERROR 2002 (HY000): Can't connect to local server")).toContain('Start the MariaDB service')
  })

  it('deja un mensaje genérico para el resto', () => {
    expect(mariaDbRootError('algo raro')).toContain('valet_studio')
  })
})

describe('credenciales guardadas', () => {
  const valid = {
    host: MARIADB_HOST, port: MARIADB_PORT, username: MARIADB_USER, password: 'secreta-larga-1'
  }

  it('acepta un objeto completo y devuelve tal cual', () => {
    expect(parseMariaDbCredentials(JSON.stringify(valid))).toEqual(valid)
  })

  it('rechaza lo incompleto o mal tipado', () => {
    expect(parseMariaDbCredentials(null)).toBeNull()
    expect(parseMariaDbCredentials('')).toBeNull()
    expect(parseMariaDbCredentials('no es json')).toBeNull()
    expect(parseMariaDbCredentials('{}')).toBeNull()
    expect(parseMariaDbCredentials(JSON.stringify({ ...valid, password: '' }))).toBeNull()
    expect(parseMariaDbCredentials(JSON.stringify({ ...valid, port: 0 }))).toBeNull()
    expect(parseMariaDbCredentials(JSON.stringify({ ...valid, port: 99999 }))).toBeNull()
    expect(parseMariaDbCredentials(JSON.stringify({ ...valid, username: 42 }))).toBeNull()
  })
})

const noSleep = async (): Promise<void> => undefined

describe('waitUntil', () => {
  it('devuelve true en cuanto el sondeo responde', async () => {
    let calls = 0
    expect(await waitUntil(async () => ++calls === 3, { attempts: 10, sleep: noSleep })).toBe(true)
    expect(calls).toBe(3)
  })

  it('devuelve false al agotar los intentos y tolera sondeos que lanzan', async () => {
    let calls = 0
    const ok = await waitUntil(async () => { calls++; throw new Error('boom') }, { attempts: 4, sleep: noSleep })
    expect(ok).toBe(false)
    expect(calls).toBe(4)
  })

  it('no duerme tras el último intento', async () => {
    const sleeps: number[] = []
    await waitUntil(async () => false, { attempts: 3, delayMs: 5, sleep: async (ms) => { sleeps.push(ms) } })
    expect(sleeps).toEqual([5, 5])
  })
})

describe('retryTransient', () => {
  it('reintenta los errores de conexión y acaba funcionando', async () => {
    let calls = 0
    const value = await retryTransient(async () => {
      if (++calls < 3) throw new Error("ERROR 2002 (HY000): Can't connect to local MySQL server through socket")
      return 'ok'
    }, { sleep: noSleep })
    expect(value).toBe('ok')
    expect(calls).toBe(3)
  })

  it('no reintenta un acceso denegado', async () => {
    let calls = 0
    await expect(retryTransient(async () => {
      calls++
      throw new Error('ERROR 1698 (28000): Access denied for user root')
    }, { sleep: noSleep })).rejects.toThrow(/access denied/i)
    expect(calls).toBe(1)
  })

  it('propaga el error si sigue fallando tras los intentos', async () => {
    let calls = 0
    await expect(retryTransient(async () => {
      calls++
      throw new Error('Connection refused')
    }, { attempts: 2, sleep: noSleep })).rejects.toThrow(/refused/)
    expect(calls).toBe(2)
  })

  it('clasifica los errores transitorios', () => {
    expect(isTransientMariaDbError("Can't connect to local MySQL server")).toBe(true)
    expect(isTransientMariaDbError('MySQL server has gone away')).toBe(true)
    expect(isTransientMariaDbError('Access denied for user')).toBe(false)
  })
})

describe('writeFileAtomic', () => {
  it('escribe con el modo pedido y no deja temporales', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vd-atomic-'))
    try {
      const file = join(dir, 'mariadb.json')
      await writeFileAtomic(file, '{"a":1}\n', 0o600)
      expect(await readFile(file, 'utf8')).toBe('{"a":1}\n')
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(await readdir(dir)).toEqual(['mariadb.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reemplaza el contenido anterior y conserva el original si falla', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vd-atomic-'))
    try {
      const file = join(dir, 'mariadb.json')
      await writeFile(file, 'old')
      await writeFileAtomic(file, 'new', 0o600)
      expect(await readFile(file, 'utf8')).toBe('new')
      // El destino es un directorio: rename falla y el temporal se limpia.
      const target = join(dir, 'sub')
      await writeFile(join(dir, 'keep'), 'x')
      await expect(writeFileAtomic(join(target, 'missing', 'f.json'), 'z', 0o600)).rejects.toThrow()
      expect((await readdir(dir)).sort()).toEqual(['keep', 'mariadb.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
