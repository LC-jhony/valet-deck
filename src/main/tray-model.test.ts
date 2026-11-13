import { describe, expect, it } from 'vitest'
import { MAX_SITES, buildTrayModel, trayHealth, traySummary } from './tray-model'
import type { Service, Site } from '../shared/types'

const service = (name: string, active: boolean): Service => ({ name, active })
const site = (name: string, secure = false): Site => ({
  name,
  path: `/${name}`,
  kind: 'parked',
  secure,
  url: `${secure ? 'https' : 'http'}://${name}.test`
})

const model = (services: Service[] = [], sites: Site[] = []) =>
  buildTrayModel(services, sites)

describe('modelo del menú de la bandeja', () => {
  it('abre con "Open Valet Deck" y cierra con "Quit Valet Deck"', () => {
    const entries = model()
    expect(entries[0]).toEqual({ kind: 'action', id: 'open', label: 'Open Valet Deck' })
    expect(entries.at(-1)).toEqual({ kind: 'action', id: 'quit', label: 'Quit Valet Deck' })
  })

  it('cada servicio es una línea de estado con su color', () => {
    const entries = model([service('nginx', true), service('mariadb', false)])
    expect(entries).toContainEqual({ kind: 'status', label: 'nginx', tone: 'ok' })
    expect(entries).toContainEqual({ kind: 'status', label: 'mariadb', tone: 'error' })
  })

  it('resume la salud del stack y elige el color del icono', () => {
    expect(trayHealth([])).toBe('neutral')
    expect(trayHealth([service('nginx', true), service('mariadb', true)])).toBe('ok')
    expect(trayHealth([service('nginx', true), service('mariadb', false)])).toBe('warn')
    expect(trayHealth([service('nginx', false), service('mariadb', false)])).toBe('error')
    expect(traySummary([])).toEqual({ label: 'No services detected', tone: 'muted' })
    expect(traySummary([service('nginx', true)])).toEqual({ label: 'All services running', tone: 'ok' })
    expect(traySummary([service('nginx', true), service('mariadb', false)])).toEqual({
      label: '1 of 2 services running',
      tone: 'warn'
    })
  })

  it('no muestra entradas de correo: el catcher no es un servicio del sistema', () => {
    expect(model([], []).some((e) => e.kind === 'status' && e.label.includes('Mail'))).toBe(false)
  })

  it('los sitios van en un submenú con su host, sin protocolo', () => {
    const entries = model([], [site('mi-app'), site('shop', true)])
    const submenu = entries.find((e) => e.kind === 'submenu')
    expect(submenu).toEqual({
      kind: 'submenu',
      label: 'Sites (2)',
      items: [
        { label: 'mi-app — mi-app.test', url: 'http://mi-app.test' },
        { label: 'shop — shop.test', url: 'https://shop.test' }
      ]
    })
  })

  it('sin sitios muestra un aviso en lugar de un submenú vacío', () => {
    const entries = model()
    expect(entries.some((e) => e.kind === 'status' && e.label === 'No sites yet')).toBe(true)
    expect(entries.some((e) => e.kind === 'submenu')).toBe(false)
  })

  it('recorta la lista de sitios: una bandeja con cientos de enlaces no se puede usar', () => {
    const many = Array.from({ length: MAX_SITES + 10 }, (_, i) => site(`site-${i}`))
    const entries = model([], many)
    const submenu = entries.find((e) => e.kind === 'submenu')
    expect(submenu?.kind === 'submenu' && submenu.items).toHaveLength(MAX_SITES)
    expect(submenu?.kind === 'submenu' && submenu.label).toBe(`Sites (${MAX_SITES})`)
  })
})
