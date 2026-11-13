// Modelo puro del menú de la bandeja. Recibe servicios y sitios, y devuelve las
// entradas del menú sin Electron: así se puede probar sin abrir la aplicación.
// `tray.ts` es el que lo traduce a `Menu` y el que elige el icono por color.

import type { Service, Site } from '../shared/types'

/** Máximo de sitios en el menú: una bandeja con cientos de enlaces no se puede usar. */
export const MAX_SITES = 30

/** Color de una línea de estado. `tray.ts` lo convierte en un punto de color. */
export type TrayTone = 'ok' | 'warn' | 'error' | 'muted'

/** Salud global del stack, para el icono de la bandeja. */
export type TrayHealth = 'ok' | 'warn' | 'error' | 'neutral'

/** Entrada del menú de la bandeja, sin tipos de Electron. */
export type TrayEntry =
  | { kind: 'action'; id: 'open' | 'quit'; label: string }
  | { kind: 'sep' }
  | { kind: 'status'; label: string; tone: TrayTone }
  | { kind: 'submenu'; label: string; items: { label: string; url: string }[] }

const hostOf = (url: string): string => url.replace(/^https?:\/\//, '')

/** Verde si todo corre, ámbar si falta algo y rojo si no corre nada. */
export function trayHealth(services: Service[]): TrayHealth {
  if (!services.length) return 'neutral'
  const running = services.filter((service) => service.active).length
  if (running === services.length) return 'ok'
  return running === 0 ? 'error' : 'warn'
}

/** Resumen de una línea para el menú y el tooltip del icono. */
export function traySummary(services: Service[]): { label: string; tone: TrayTone } {
  if (!services.length) return { label: 'No services detected', tone: 'muted' }
  const running = services.filter((service) => service.active).length
  if (running === services.length) return { label: 'All services running', tone: 'ok' }
  if (running === 0) return { label: 'No services running', tone: 'error' }
  return { label: `${running} of ${services.length} services running`, tone: 'warn' }
}

/**
 * Entradas del menú, en orden: abrir, resumen, servicios, sitios y salir. Los
 * estados y los sitios son de solo lectura; las acciones viven en el panel.
 */
export function buildTrayModel(services: Service[], sites: Site[]): TrayEntry[] {
  const entries: TrayEntry[] = [
    { kind: 'action', id: 'open', label: 'Open Valet Deck' },
    { kind: 'sep' },
    { kind: 'status', ...traySummary(services) }
  ]
  for (const s of services) {
    entries.push({ kind: 'status', label: s.name, tone: s.active ? 'ok' : 'error' })
  }
  entries.push({ kind: 'sep' })
  if (sites.length) {
    entries.push({
      kind: 'submenu',
      label: `Sites (${Math.min(sites.length, MAX_SITES)})`,
      items: sites.slice(0, MAX_SITES).map((s) => ({
        label: `${s.name} — ${hostOf(s.url)}`,
        url: s.url
      }))
    })
  } else {
    entries.push({ kind: 'status', label: 'No sites yet', tone: 'muted' })
  }
  entries.push({ kind: 'sep' }, { kind: 'action', id: 'quit', label: 'Quit Valet Deck' })
  return entries
}
