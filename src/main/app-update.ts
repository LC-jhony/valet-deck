// Actualización del propio Valet Deck. electron-updater lee `app-update.yml`
// (lo genera electron-builder desde `build.publish`), descarga el artefacto de
// la release de GitHub y lo instala: en .deb/.rpm pide la contraseña una vez por
// polkit; en AppImage reemplaza el archivo. En desarrollo no se activa.
import { app } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { AppUpdateState } from '../shared/types'

const listeners = new Set<(state: AppUpdateState) => void>()

let state: AppUpdateState = {
  status: app.isPackaged ? 'idle' : 'disabled',
  current: app.getVersion(),
  latest: '',
  percent: 0,
  message: app.isPackaged ? '' : 'Updates are only available in the installed app.'
}

export function appUpdateState(): AppUpdateState {
  return state
}

export function onAppUpdate(cb: (state: AppUpdateState) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function emit(patch: Partial<AppUpdateState>): void {
  state = { ...state, ...patch }
  for (const cb of listeners) cb(state)
}

/** Traduce los fallos de electron-updater a algo que se pueda leer y accionar. */
function friendly(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/ENOTFOUND|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|net::ERR|ECONNREFUSED/i.test(message)) {
    return 'No network connection: the update could not be checked. Try again when you are online.'
  }
  if (/404|latest-linux|Cannot find|Unable to find/i.test(message)) {
    return 'The release does not include latest-linux.yml, so the update cannot be verified. Download it by hand.'
  }
  if (/EACCES|EPERM|permission denied/i.test(message)) {
    return 'The downloaded file cannot be installed with the current permissions.'
  }
  if (/sha512|checksum/i.test(message)) {
    return 'The download does not match the published signature; it was discarded.'
  }
  return message
}

let configured = false

function configure(): void {
  if (configured || !app.isPackaged) return
  configured = true
  // La descarga y la instalación las decide el usuario desde el panel.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  // Solo para pruebas: permite apuntar a un feed local con la misma forma que
  // una release (latest-linux.yml + artefactos) sin publicar una versión real.
  const feed = (process.env.VALET_STUDIO_UPDATE_URL ?? '').trim()
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed })

  autoUpdater.on('checking-for-update', () => emit({ status: 'checking', percent: 0, message: '' }))
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    emit({ status: 'available', latest: info.version, percent: 0, message: '' })
  })
  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    emit({ status: 'current', latest: info.version, percent: 0, message: '' })
  })
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    emit({ status: 'downloading', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    emit({ status: 'ready', latest: info.version, percent: 100, message: '' })
  })
  autoUpdater.on('error', (error: Error) => emit({ status: 'error', message: friendly(error) }))
}

/** Consulta si hay una versión nueva. No descarga nada. */
export async function checkAppUpdate(): Promise<AppUpdateState> {
  if (!app.isPackaged) return state
  configure()
  emit({ status: 'checking', percent: 0, message: '' })
  try {
    await autoUpdater.checkForUpdates()
    // Si el feed no emitió ningún evento, al menos no se queda «checking».
    if (state.status === 'checking') emit({ status: 'current' })
  } catch (error) {
    emit({ status: 'error', message: friendly(error) })
  }
  return state
}

/** Descarga la versión disponible. */
export async function downloadAppUpdate(): Promise<AppUpdateState> {
  if (!app.isPackaged) return state
  if (state.status !== 'available') return state
  emit({ status: 'downloading', percent: 0, message: '' })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    emit({ status: 'error', message: friendly(error) })
  }
  return state
}

/** Cierra el panel y deja que el instalador aplique la versión descargada. */
export async function installAppUpdate(): Promise<void> {
  if (!app.isPackaged) throw new Error('Updates are only available in the installed app.')
  if (state.status !== 'ready') throw new Error('There is no downloaded update to install.')
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}
