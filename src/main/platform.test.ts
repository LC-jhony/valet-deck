import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  OLD_RELEASES_SCRIPT, detectPlatform, eolWarning, parseOsRelease, planPhp, ppaAvailable, sourcesUseMainArchive
} from './platform'

const run = promisify(execFile)

const GROOVY = `NAME="Ubuntu"
VERSION="20.10 (Groovy Gorilla)"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 20.10"
VERSION_ID="20.10"
VERSION_CODENAME=groovy
UBUNTU_CODENAME=groovy
`

const NOBLE = `NAME="Ubuntu"
VERSION_ID="24.04"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 24.04.2 LTS"
VERSION_CODENAME=noble
`

const DEBIAN = `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
ID=debian
VERSION_ID="12"
VERSION_CODENAME=bookworm
`

const STONKING = `NAME="Ubuntu"
VERSION="26.10 (Stonking Squirrel)"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 26.10"
VERSION_ID="26.10"
VERSION_CODENAME=stonking
`

const MINT = `NAME="Linux Mint"
ID=linuxmint
ID_LIKE="ubuntu debian"
VERSION_ID="20.3"
VERSION_CODENAME=una
UBUNTU_CODENAME=focal
PRETTY_NAME="Linux Mint 20.3"
`

const NOW = new Date('2026-11-06T12:00:00Z')

describe('parseOsRelease', () => {
  it('lee versión, codename y nombre', () => {
    expect(parseOsRelease(GROOVY)).toMatchObject({
      id: 'ubuntu', versionId: '20.10', codename: 'groovy', prettyName: 'Ubuntu 20.10'
    })
  })

  it('tolera un archivo vacío', () => {
    expect(parseOsRelease('')).toMatchObject({ id: '', versionId: '', codename: '', prettyName: 'unknown' })
  })

  it('usa UBUNTU_CODENAME cuando falta VERSION_CODENAME', () => {
    expect(parseOsRelease('ID=ubuntu\nUBUNTU_CODENAME=focal\n').codename).toBe('focal')
  })
})

describe('detectPlatform', () => {
  it('marca Ubuntu 20.10 como sin soporte', () => {
    const info = detectPlatform(GROOVY, NOW)
    expect(info.ubuntu).toBe(true)
    expect(info.support).toBe('eol')
    expect(info.eolDate).toBe('2021-07-22')
  })

  it('no marca como EOL una versión vigente', () => {
    expect(detectPlatform(NOBLE, NOW).support).toBe('supported')
  })

  it('una fecha de EOL futura no cuenta como terminada', () => {
    expect(detectPlatform(GROOVY, new Date('2021-01-01T00:00:00Z')).support).toBe('supported')
  })

  it('Debian no es Ubuntu y su soporte es desconocido', () => {
    const info = detectPlatform(DEBIAN, NOW)
    expect(info.ubuntu).toBe(false)
    expect(info.support).toBe('unknown')
  })

  it('reconoce derivadas por ID_LIKE y usa el codename de Ubuntu', () => {
    const info = detectPlatform(MINT, NOW)
    expect(info.ubuntu).toBe(true)
    expect(info.codename).toBe('una')
  })
})

describe('ppaAvailable y planPhp', () => {
  it('el PPA sirve en las LTS vigentes', () => {
    expect(ppaAvailable(detectPlatform(NOBLE, NOW))).toBe(true)
    expect(planPhp(detectPlatform(NOBLE, NOW), '8.5')).toEqual({
      version: '8.5', note: null, repository: 'ppa', suite: 'noble'
    })
  })

  it('en Ubuntu 20.10 usa el PHP de la distribución y lo explica', () => {
    const plan = planPhp(detectPlatform(GROOVY, NOW), '8.5')
    expect(plan.version).toBeNull()
    expect(plan.note).toMatch(/Ubuntu 20\.10.*Ondrej PPA.*8\.5/)
  })

  it('en Ubuntu 26.10 usa PHP 8.5 de la distribución y no Sury', () => {
    const plan = planPhp(detectPlatform(STONKING, NOW), '8.5')
    expect(plan).toEqual({ version: null, note: expect.any(String), repository: null, suite: null })
    expect(plan.note).toMatch(/Ubuntu 26\.10.*PHP 8\.5/)
    expect(plan.note).not.toMatch(/newest Sury suite/)
  })

  it('no fija PHP en Debian', () => {
    expect(planPhp(detectPlatform(DEBIAN, NOW), '8.5')).toEqual({
      version: null, note: null, repository: null, suite: null
    })
  })

  it('sin codename conserva el comportamiento anterior', () => {
    expect(ppaAvailable(detectPlatform('ID=ubuntu\n', NOW))).toBe(true)
  })
})

describe('eolWarning', () => {
  it('avisa solo cuando la versión terminó', () => {
    expect(eolWarning(detectPlatform(GROOVY, NOW))).toMatch(/no longer receives security updates since 2021-07-22/)
    expect(eolWarning(detectPlatform(NOBLE, NOW))).toBeNull()
    expect(eolWarning(detectPlatform(DEBIAN, NOW))).toBeNull()
  })
})

describe('sourcesUseMainArchive', () => {
  it('detecta el archivo principal y los espejos por país', () => {
    expect(sourcesUseMainArchive('deb http://archive.ubuntu.com/ubuntu groovy main')).toBe(true)
    expect(sourcesUseMainArchive('deb http://pe.archive.ubuntu.com/ubuntu groovy main')).toBe(true)
    expect(sourcesUseMainArchive('deb http://security.ubuntu.com/ubuntu groovy-security main')).toBe(true)
  })

  it('ignora comentarios y old-releases', () => {
    expect(sourcesUseMainArchive('# deb http://archive.ubuntu.com/ubuntu groovy main')).toBe(false)
    expect(sourcesUseMainArchive('deb http://old-releases.ubuntu.com/ubuntu groovy main')).toBe(false)
  })
})

describe('OLD_RELEASES_SCRIPT', () => {
  it('tiene sintaxis bash válida', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vd-old-'))
    try {
      const file = join(dir, 'x.sh')
      await writeFile(file, OLD_RELEASES_SCRIPT)
      await run('bash', ['-n', file])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reescribe los orígenes, deja copia y es idempotente', async () => {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
    if (!isRoot) return // el guion exige root; la sintaxis ya se comprobó arriba
    const dir = await mkdtemp(join(tmpdir(), 'vd-old-'))
    try {
      const apt = join(dir, 'apt')
      await mkdir(join(apt, 'sources.list.d'), { recursive: true })
      const original = [
        'deb http://pe.archive.ubuntu.com/ubuntu groovy main restricted',
        'deb http://security.ubuntu.com/ubuntu groovy-security main',
        'deb http://ppa.launchpad.net/foo/bar/ubuntu groovy main'
      ].join('\n') + '\n'
      await writeFile(join(apt, 'sources.list'), original)
      const script = join(dir, 'x.sh')
      await writeFile(script, OLD_RELEASES_SCRIPT, { mode: 0o700 })
      const backup = join(dir, 'backup')

      await run('bash', [script, backup, apt])
      const after = await readFile(join(apt, 'sources.list'), 'utf8')
      expect(after).toContain('deb http://old-releases.ubuntu.com/ubuntu groovy main restricted')
      expect(after).toContain('deb http://old-releases.ubuntu.com/ubuntu groovy-security main')
      expect(after).toContain('ppa.launchpad.net/foo/bar')
      expect(await readFile(join(backup, 'apt', 'sources.list.bak'), 'utf8')).toBe(original)

      await run('bash', [script, backup, apt])
      expect(await readFile(join(apt, 'sources.list'), 'utf8')).toBe(after)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
