import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortsInfo, PortUsage } from '../shared/types'

// La secuencia real de systemctl se prueba sin tocar la máquina: `sudo` se
// sustituye por un registrador. Los demás exports de elevate se conservan
// porque helpers, php y el instalador los importan en la misma cadena.
const state = vi.hoisted(() => ({
  calls: [] as string[][],
  failDisable: false
}))

vi.mock('./elevate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./elevate')>()
  return {
    ...actual,
    sudo: async (command: string, args: string[]) => {
      state.calls.push([command, ...args])
      if (state.failDisable && args[0] === 'disable') throw new Error('Unit is masked')
    }
  }
})

import { freeWebPortsWith } from './valet'

const usage = (port: number, process: string, unit: string): PortUsage => ({ port, process, pid: '42', unit })

const info = (usageList: PortUsage[]): PortsInfo => ({
  config: { http: 80, https: 443 },
  usage: usageList,
  nginxActive: false,
  apache: { installed: false, active: false, enabled: false, http: null, https: null }
})

const flock = [
  usage(80, 'Flock (flock@jhony.service)', 'flock@jhony.service'),
  usage(443, 'Flock (flock@jhony.service)', 'flock@jhony.service')
]

beforeEach(() => {
  state.calls = []
  state.failDisable = false
})

describe('liberar los puertos web', () => {
  it('para al dueño y arranca nginx sin desactivarlo', async () => {
    await freeWebPortsWith(info(flock))
    expect(state.calls).toEqual([
      ['systemctl', 'stop', 'flock@jhony.service'],
      ['systemctl', 'start', 'nginx']
    ])
  })

  it('lo desactiva al arranque solo cuando se pide', async () => {
    await freeWebPortsWith(info(flock), true)
    expect(state.calls).toEqual([
      ['systemctl', 'stop', 'flock@jhony.service'],
      ['systemctl', 'disable', 'flock@jhony.service'],
      ['systemctl', 'start', 'nginx']
    ])
  })

  it('arranca nginx aunque falle la desactivación, y lo explica', async () => {
    state.failDisable = true
    await expect(freeWebPortsWith(info(flock), true)).rejects.toThrow(
      /nginx is running, but flock@jhony\.service could not be disabled at boot/
    )
    expect(state.calls).toEqual([
      ['systemctl', 'stop', 'flock@jhony.service'],
      ['systemctl', 'disable', 'flock@jhony.service'],
      ['systemctl', 'start', 'nginx']
    ])
  })

  it('solo arranca nginx cuando no hay conflicto', async () => {
    await freeWebPortsWith(info([usage(80, 'nginx', 'nginx.service')]))
    expect(state.calls).toEqual([['systemctl', 'start', 'nginx']])
  })
})
