// La retirada del Sury obsoleto, probada con carpetas temporales: es la parte
// que toca el sistema (copia de seguridad, borrado elevado y apt-get update).
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeStaleSuryRepository, type PhpRepoRunner, type StaleSuryPaths } from './php-repo'

const OS_2610 = `NAME="Ubuntu"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 26.10"
VERSION_ID="26.10"
VERSION_CODENAME=stonking
`

const OS_2404 = `NAME="Ubuntu"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 24.04.2 LTS"
VERSION_ID="24.04"
VERSION_CODENAME=noble
`

const SURY_LINE =
  'deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ resolute main'

/** Ejecutor que graba las llamadas y aplica de verdad los `rm` del script. */
function fakeRunner() {
  const calls: string[] = []
  const logs: string[] = []
  const runner: PhpRepoRunner = {
    elevated: async (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'rm') await rm(args[1], { force: true })
    },
    log: (text) => logs.push(text)
  }
  return { runner, calls, logs }
}

/** Carpeta temporal con su os-release y, si toca, una lista de Sury. */
async function scenario(osRelease: string, withList: boolean): Promise<{
  dir: string
  paths: StaleSuryPaths
}> {
  const dir = await mkdtemp(join(tmpdir(), 'vd-sury-'))
  const apt = join(dir, 'apt')
  await mkdir(apt, { recursive: true })
  const osReleasePath = join(dir, 'os-release')
  await writeFile(osReleasePath, osRelease)
  const suryList = join(apt, 'sury-php.list')
  if (withList) await writeFile(suryList, `${SURY_LINE}\n`)
  return {
    dir,
    paths: {
      osRelease: osReleasePath,
      suryList,
      backupRoot: join(dir, 'backups')
    }
  }
}

describe('removeStaleSuryRepository', () => {
  it('retira el Sury con copia de seguridad en Ubuntu 26.10 y refresca apt', async () => {
    const { dir, paths } = await scenario(OS_2610, true)
    const { runner, calls, logs } = fakeRunner()
    try {
      expect(await removeStaleSuryRepository(runner, paths)).toBe(true)
      expect(existsSync(paths.suryList)).toBe(false)
      const saved = await readdir(paths.backupRoot)
      expect(saved).toHaveLength(1)
      expect(await readFile(join(paths.backupRoot, saved[0]), 'utf8')).toBe(`${SURY_LINE}\n`)
      expect(calls.some((c) => c.startsWith('rm -f ') && c.endsWith('sury-php.list'))).toBe(true)
      expect(calls.some((c) => c.includes('apt-get') && c.endsWith('update'))).toBe(true)
      expect(logs.join('')).toContain('obsolete Sury PHP repository')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('no toca nada en una LTS con PPA ni cuando no hay lista de Sury', async () => {
    const lts = await scenario(OS_2404, true)
    const ltsRun = fakeRunner()
    try {
      expect(await removeStaleSuryRepository(ltsRun.runner, lts.paths)).toBe(false)
      expect(existsSync(lts.paths.suryList)).toBe(true)
      expect(ltsRun.calls).toEqual([])

      const clean = await scenario(OS_2610, false)
      const cleanRun = fakeRunner()
      try {
        expect(await removeStaleSuryRepository(cleanRun.runner, clean.paths)).toBe(false)
        expect(cleanRun.calls).toEqual([])
      } finally {
        await rm(clean.dir, { recursive: true, force: true })
      }
    } finally {
      await rm(lts.dir, { recursive: true, force: true })
    }
  })

  it('es idempotente: la segunda pasada ya no encuentra nada', async () => {
    const { dir, paths } = await scenario(OS_2610, true)
    try {
      const first = fakeRunner()
      expect(await removeStaleSuryRepository(first.runner, paths)).toBe(true)
      const second = fakeRunner()
      expect(await removeStaleSuryRepository(second.runner, paths)).toBe(false)
      expect(second.calls).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('se niega a borrar si no puede guardar la copia', async () => {
    const { dir, paths } = await scenario(OS_2610, true)
    await writeFile(paths.backupRoot, 'not a directory')
    const { runner, calls } = fakeRunner()
    try {
      await expect(removeStaleSuryRepository(runner, paths)).rejects.toThrow(/Could not save a copy/)
      expect(existsSync(paths.suryList)).toBe(true)
      expect(calls).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
