// Bandeja del sistema: el panel sigue vivo en segundo plano y la bandeja
// muestra el estado de los servicios y los sitios a un clic. El icono cambia
// de color (verde, ámbar o rojo) según la salud del stack. El menú se
// reconstruye solo cuando el modelo cambia; en Linux (appindicator) el icono
// no tiene eventos de clic, así que todo pasa por el menú. Solo lectura y sin
// elevación: las acciones viven en el panel.

import { Menu, Tray, app, shell, type BrowserWindow, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import { listServices, listSites } from './valet'
import { buildTrayModel, trayHealth, traySummary, type TrayEntry, type TrayHealth, type TrayTone } from './tray-model'

const REFRESH_MS = 10_000
const DOT: Record<TrayTone, string> = {
  ok: '🟢',
  warn: '🟡',
  error: '🔴',
  muted: '⚪'
}

export type TrayIcons = Partial<Record<TrayHealth, NativeImage>>

let tray: Tray | null = null
let timer: NodeJS.Timeout | null = null
let current: TrayEntry[] = []
let baseImage: NativeImage | null = null
let stateIcons: TrayIcons = {}

/** Crea el icono de la bandeja y arranca el refresco periódico del menú. */
export async function createTray(
  icon: NativeImage,
  icons: TrayIcons,
  getWindow: () => BrowserWindow | null
): Promise<void> {
  if (tray) return
  baseImage = icon
  stateIcons = icons
  const image = icon.isEmpty() ? icon : icon.resize({ width: 24, height: 24 })
  tray = new Tray(image)
  tray.setToolTip('Valet Deck')
  await refreshTray(getWindow)
  timer = setInterval(() => { void refreshTray(getWindow) }, REFRESH_MS)
  timer.unref()
}

/** Vuelve a leer servicios y sitios; reconstruye el menú solo si cambió algo. */
export async function refreshTray(getWindow: () => BrowserWindow | null): Promise<void> {
  if (!tray) return
  const [services, sites] = await Promise.all([
    listServices().catch(() => []),
    listSites().catch(() => [])
  ])
  const next = buildTrayModel(services, sites)
  const health = trayHealth(services)
  const image = stateIcons[health] ?? baseImage
  if (image && !image.isEmpty()) tray.setImage(image)
  tray.setToolTip(`Valet Deck — ${traySummary(services).label}`)
  if (JSON.stringify(next) === JSON.stringify(current)) return
  current = next
  tray.setContextMenu(Menu.buildFromTemplate(toTemplate(next, getWindow)))
}

function toTemplate(entries: TrayEntry[], getWindow: () => BrowserWindow | null): MenuItemConstructorOptions[] {
  return entries.map((e) => {
    switch (e.kind) {
      case 'sep':
        return { type: 'separator' }
      case 'status':
        return { label: `${DOT[e.tone]} ${e.label}`, enabled: false }
      case 'submenu':
        return {
          label: e.label,
          submenu: e.items.map((it) => ({
            label: it.label,
            click: () => { void shell.openExternal(it.url) }
          }))
        }
      case 'action':
        return e.id === 'open'
          ? {
              label: e.label,
              click: () => {
                const w = getWindow()
                if (w) { w.show(); w.focus() }
              }
            }
          : { label: e.label, click: () => app.quit() }
    }
  })
}

/** Suelta el icono y el temporizador: antes de salir no debe quedar nada colgando. */
export function destroyTray(): void {
  if (timer) { clearInterval(timer); timer = null }
  tray?.destroy()
  tray = null
  current = []
  baseImage = null
  stateIcons = {}
}
