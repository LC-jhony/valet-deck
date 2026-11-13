import { beforeEach, describe, expect, it, vi } from 'vitest'

const existsSync = vi.fn<(p: string) => boolean>()
const run = vi.fn<(cmd: string, args: string[]) => Promise<string>>()
const readFile = vi.fn<(p: string) => Promise<string>>()

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: (p: string) => existsSync(p)
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: ((p: string) => readFile(p)) as unknown as typeof import('node:fs/promises').readFile
}))
vi.mock('./exec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec')>()),
  run: (cmd: string, args?: string[]) => run(cmd, args ?? [])
}))

import { phpInfo } from './valet'

const osRelease = (id: string): string => `NAME="Distro"\nID=${id}\n`
const cliVersion = (value: string) =>
  run.mockImplementation(async (cmd, args) => {
    if (cmd === 'php' && args[0] === '-r') return value
    if (cmd === 'systemctl' && args[0] === 'is-active') return activeUnits.has(args[1]) ? 'active' : 'inactive'
    return ''
  })

let activeUnits: Set<string>

beforeEach(() => {
  activeUnits = new Set()
  existsSync.mockReturnValue(false)
  readFile.mockResolvedValue(osRelease('ubuntu'))
})

describe('estado del PHP gestionado', () => {
  it('en Ubuntu fija 8.5 aunque el php de la CLI reporte otra versión', async () => {
    existsSync.mockImplementation((p) => p === '/usr/sbin/php-fpm8.4')
    activeUnits.add('php8.4-fpm')
    cliVersion('8.4')
    const info = await phpInfo()
    expect(info.target).toBe('8.5')
    expect(info.managed).toBe('8.5')
    expect(info.current).toBe('8.4')
    // El estado describe el PHP gestionado, no el que reporta la CLI.
    expect(info.installed).toBe(false)
    expect(info.fpmActive).toBe(false)
  })

  it('en Ubuntu con 8.5 instalado y activo lo reporta como en uso', async () => {
    existsSync.mockImplementation((p) => p === '/usr/sbin/php-fpm8.5')
    activeUnits.add('php8.5-fpm')
    cliVersion('8.5')
    const info = await phpInfo()
    expect(info.target).toBe('8.5')
    expect(info.managed).toBe('8.5')
    expect(info.installed).toBe(true)
    expect(info.fpmActive).toBe(true)
  })

  it('en Debian no fija versión: usa el PHP de la distribución', async () => {
    readFile.mockResolvedValue(osRelease('debian'))
    existsSync.mockImplementation((p) => p === '/usr/sbin/php-fpm8.4')
    activeUnits.add('php8.4-fpm')
    cliVersion('8.4')
    const info = await phpInfo()
    expect(info.target).toBeNull()
    expect(info.managed).toBe('8.4')
    expect(info.installed).toBe(true)
    expect(info.fpmActive).toBe(true)
  })

  it('en Fedora cuenta también con el binario y el servicio genéricos', async () => {
    readFile.mockResolvedValue(osRelease('fedora'))
    existsSync.mockImplementation((p) => p === '/usr/sbin/php-fpm')
    activeUnits.add('php-fpm')
    cliVersion('8.4')
    const info = await phpInfo()
    expect(info.target).toBeNull()
    expect(info.managed).toBe('8.4')
    expect(info.installed).toBe(true)
    expect(info.fpmActive).toBe(true)
  })

  it('sin PHP que reporte versión no inventa una', async () => {
    readFile.mockResolvedValue(osRelease('debian'))
    cliVersion('')
    const info = await phpInfo()
    expect(info.target).toBeNull()
    expect(info.managed).toBe('')
    expect(info.installed).toBe(false)
    expect(info.fpmActive).toBe(false)
  })
})
