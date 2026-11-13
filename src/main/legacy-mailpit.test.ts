import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { legacyMailpitPaths, removeLegacyMailpit } from './legacy-mailpit'

describe('legacy Mailpit cleanup', () => {
  it('builds the paths used by the 0.3.x service', () => {
    expect(legacyMailpitPaths('/home/ana')).toEqual({
      unit: '/home/ana/.config/systemd/user/valet-studio-mailpit.service',
      binary: '/home/ana/.valet-studio/bin/mailpit',
      data: '/home/ana/.valet-studio/mailpit'
    })
  })

  it('stops the old service and removes its unit and binary but keeps messages', async () => {
    const home = await mkdtemp(join(tmpdir(), 'valet-mailpit-'))
    const paths = legacyMailpitPaths(home)
    await mkdir(join(home, '.config/systemd/user'), { recursive: true })
    await mkdir(join(home, '.valet-studio/bin'), { recursive: true })
    await mkdir(paths.data, { recursive: true })
    await writeFile(paths.unit, '[Service]\nExecStart=/bin/true\n')
    await writeFile(paths.binary, 'binario')
    await writeFile(join(paths.data, 'mailpit.db'), 'mensajes')

    const calls: string[][] = []
    const changed = await removeLegacyMailpit(home, async (cmd, args) => {
      calls.push([cmd, ...args])
      return ''
    })

    expect(changed).toBe(true)
    expect(calls).toEqual([
      ['systemctl', '--user', 'stop', 'valet-studio-mailpit.service'],
      ['systemctl', '--user', 'disable', 'valet-studio-mailpit.service'],
      ['systemctl', '--user', 'daemon-reload']
    ])
    expect(existsSync(paths.unit)).toBe(false)
    expect(existsSync(paths.binary)).toBe(false)
    expect(await readFile(join(paths.data, 'mailpit.db'), 'utf8')).toBe('mensajes')
    await rm(home, { recursive: true, force: true })
  })

  it('does nothing when there is no previous install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'valet-mailpit-'))
    const calls: string[][] = []
    const changed = await removeLegacyMailpit(home, async (cmd, args) => {
      calls.push([cmd, ...args])
      return ''
    })
    expect(changed).toBe(false)
    expect(calls).toEqual([])
    await rm(home, { recursive: true, force: true })
  })
})
