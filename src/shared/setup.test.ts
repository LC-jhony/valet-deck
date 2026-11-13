import { describe, expect, it } from 'vitest'
import type { Env } from './types'
import { setupComponents, setupNeeded } from './setup'

const baseEnv: Env = {
  distro: 'Ubuntu 26.10',
  pm: 'apt',
  tools: { php: true, composer: true, nginx: true, git: true, dnsmasq: true },
  portHogs: [],
  dns: {
    domain: 'test', networkManager: true, resolvedActive: true, dnsmasqBinary: true,
    dnsmasqServiceActive: false, dashboardActive: false, port: 5354, portFree: true,
    resolvConfOk: true, testResolves: true, classicLeftovers: false
  },
  composer: {
    available: true, globalHome: '/home/u/.config/composer', isolatedHome: '/home/u/.config/valet-studio/composer',
    isolatedValet: true, conflict: false, conflictDetail: ''
  },
  valet: { installed: true, path: '/usr/local/bin/valet', version: '2.4.5', isolated: true },
  php: { target: '8.5', current: '8.5', managed: '8.5', installed: true, fpmActive: true },
  node: { installed: true, version: '26.13.0', nvm: true },
  mariadb: { installed: true, active: true },
  warnings: [],
  recommendedDnsMode: 'safe',
  prereqs: [],
  elevation: 'pkexec'
}

const env = (patch: Partial<Env>): Env => ({ ...baseEnv, ...patch })

const component = (value: Env, id: string) => setupComponents(value).find((c) => c.id === id)

describe('componentes del setup', () => {
  it('no pide setup cuando los requeridos están instalados', () => {
    expect(setupNeeded(env({}))).toBe(false)
  })

  it('pide setup si falta PHP, Composer, nginx o Valet ejecutable', () => {
    expect(setupNeeded(env({ php: { target: '8.5', current: '', managed: '8.5', installed: false, fpmActive: false } }))).toBe(true)
    expect(setupNeeded(env({ tools: { ...baseEnv.tools, composer: false } }))).toBe(true)
    expect(setupNeeded(env({ tools: { ...baseEnv.tools, nginx: false } }))).toBe(true)
    expect(setupNeeded(env({ valet: { ...baseEnv.valet, installed: false, version: null } }))).toBe(true)
  })

  it('no marca Valet como missing si existe aunque no se pueda leer su versión', () => {
    const unreadable = env({ valet: { ...baseEnv.valet, version: null } })
    expect(component(unreadable, 'valet')?.installed).toBe(true)
    expect(component(unreadable, 'valet')?.detail).toContain('ready')
    expect(setupNeeded(unreadable)).toBe(false)
  })

  it('Node y MariaDB son opcionales: no bloquean la app', () => {
    const optional = env({
      node: { installed: false, version: '', nvm: false },
      mariadb: { installed: false, active: false }
    })
    expect(setupNeeded(optional)).toBe(false)
    expect(component(optional, 'node')?.required).toBe(false)
    expect(component(optional, 'mariadb')?.required).toBe(false)
  })

  it('marca Node 26 solo si está instalado en esa major', () => {
    expect(component(env({}), 'node')?.installed).toBe(true)
    expect(component(env({ node: { installed: true, version: '22.11.0', nvm: true } }), 'node')?.installed).toBe(false)
  })

  it('con versión fijada exige esa versión; sin ella acepta el PHP del sistema', () => {
    const olderApt = env({ php: { target: '8.5', current: '8.4', managed: '8.5', installed: true, fpmActive: true } })
    expect(component(olderApt, 'php')?.installed).toBe(false)
    expect(component(olderApt, 'php')?.label).toBe('PHP 8.5')

    const olderSystem = env({
      pm: 'dnf',
      php: { target: null, current: '8.4', managed: '8.4', installed: true, fpmActive: true }
    })
    expect(component(olderSystem, 'php')?.installed).toBe(true)
    expect(component(olderSystem, 'php')?.label).toBe('PHP')
  })

  it('explica qué se instalará cuando falta un componente', () => {
    const missing = env({ php: { target: '8.5', current: '', managed: '8.5', installed: false, fpmActive: false } })
    expect(component(missing, 'php')?.detail).toContain('PHP-FPM')
    expect(component(missing, 'php')?.installed).toBe(false)
  })

  it('mantiene las descripciones en una línea compacta', () => {
    expect(setupComponents(env({})).every((c) => c.detail.length <= 48)).toBe(true)
    const missing = env({
      php: { target: '8.5', current: '', managed: '8.5', installed: false, fpmActive: false },
      tools: { ...baseEnv.tools, composer: false, nginx: false },
      valet: { ...baseEnv.valet, version: null },
      node: { installed: false, version: '', nvm: false },
      mariadb: { installed: false, active: false }
    })
    expect(setupComponents(missing).every((c) => c.detail.length <= 48)).toBe(true)
  })
})
