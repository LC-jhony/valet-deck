import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, type OpenDialogOptions
} from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as v from './valet'
import * as inst from './install'
import * as upd from './updates'
import * as au from './app-update'
import * as mail from './mail'
import type { MailEvent } from '../shared/mail'
import * as sd from './site-detail'
import * as pv from './php-versions'
import * as nv from './node-versions'
import * as db from './databases'
import * as sys from './system'
import * as q from './queue'
import { openSecureInstallation } from './mariadb-secure'
import { isAppUrl as isAppUrlIn } from './window-guard'
import { createTray, destroyTray } from './tray'
import { removeLegacyMailpit } from './legacy-mailpit'
import { openSite } from './site-open'

app.setName('Valet Deck')
const ICON_PATH = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(__dirname, '../../resources/icon.png')
const ICON = existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : null
const trayIcon = (name: string) => {
  const path = app.isPackaged
    ? join(process.resourcesPath, name)
    : join(__dirname, '../../resources', name)
  return existsSync(path) ? nativeImage.createFromPath(path) : nativeImage.createEmpty()
}
const TRAY_ICONS = {
  ok: trayIcon('tray-ok.png'),
  warn: trayIcon('tray-warn.png'),
  error: trayIcon('tray-error.png')
}

const handlers: Record<string, (...a: any[]) => Promise<unknown>> = {
  'sites:list': v.listSites,
  'sites:secure': v.setSecure,
  'sites:remove': v.removeSite,
  'sites:open': openSite,
  'sites:project-info': v.projectInfo,
  'sites:cancel-create': v.cancelCreateProject,
  'sites:delete-incomplete': v.deleteIncompleteProject,
  'sites:detail': sd.getSiteDetail,
  'sites:update-settings': sd.updateSiteSettings,
  'sites:set-env': sd.setSiteEnv,
  'sites:set-database': sd.setSiteDatabase,
  'sites:apply-mail': sd.applySiteMail,
  'sites:set-mail': sd.setSiteMail,
  'sites:pin-php': sd.pinSitePhp,
  'sites:open-folder': sd.openSiteFolder,
  'sites:mail-defaults': sd.mailDefaults,
  'php:list': v.phpInfo,
  'php:versions': () => pv.phpVersionsInfo(),
  'php:use': pv.usePhpVersion,
  'php:isolate': pv.isolateSitePhp,
  'php:install-log': pv.phpInstallLog,
  'node:versions': nv.nodeVersionsInfo,
  'node:set-default': nv.setDefaultNode,
  'node:uninstall': nv.uninstallNodeVersion,
  'node:pin': nv.pinNodeVersion,
  'node:unpin': nv.unpinNodeVersion,
  'databases:info': db.databasesInfo,
  'databases:create': db.createDatabase,
  'databases:drop': db.dropDatabase,
  'databases:save-credentials': db.saveDatabaseCredentials,
  'databases:test': db.testDatabaseConnection,
  'system:settings': sys.systemSettings,
  'system:set-domain': sys.setDomain,
  'system:add-parked': sys.addParkedPath,
  'system:remove-parked': sys.removeParkedPath,
  'system:dashboard': sys.dashboardInfo,
  'system:open-folder': sys.openKnownFolder,
  'system:free-web-ports': v.freeWebPorts,
  'queue:apply': q.applyQueue,
  'queue:stop': q.stopQueue,
  'queue:logs': (name: string) => q.queueLog(name),
  'ports:scan': v.scanPorts,
  'ports:set': v.setPorts,
  'ports:setApache': v.setApachePorts,
  'services:list': v.listServices,
  'services:action': v.serviceAction,
  'services:logs': v.serviceLogs,
  'mariadb:secure-install': openSecureInstallation,
  'mail:info': mail.info,
  'mail:list': mail.list,
  'mail:get': mail.get,
  'mail:remove': mail.remove,
  'mail:clear': mail.clear,
  'mail:saveAttachment': mail.saveAttachment,
  'mail:configureEnv': mail.configureEnv,
  'mail:sendTest': mail.sendTest,
  'mail:openData': mail.openData
}

// ── Frontera renderer → main ─────────────────────────────────────────────────
// Solo la ventana principal puede llamar al IPC: el preload vive en su
// webContents, así que cualquier otra página (o un invitado inesperado) queda
// fuera aunque consiguiera ejecutar JavaScript.
let mainWindow: BrowserWindow | null = null

const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL ?? ''
const RENDERER_DIR = join(__dirname, '../renderer')

/** ¿Es una URL de la propia aplicación (renderer de desarrollo o build)? */
const isAppUrl = (url: string): boolean =>
  isAppUrlIn(url, { devUrl: RENDERER_DEV_URL, rendererDir: RENDERER_DIR })

function trustedSender(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (e.sender !== mainWindow.webContents) return false
  const frame = e.senderFrame
  return !frame || isAppUrl(frame.url)
}

function assertTrusted(e: Electron.IpcMainInvokeEvent): void {
  if (!trustedSender(e)) throw new Error('Unauthorised origin')
}

for (const [ch, fn] of Object.entries(handlers)) {
  ipcMain.handle(ch, (e, ...args) => {
    assertTrusted(e)
    return fn(...args)
  })
}

/** Avisa a la ventana principal; no falla si ya se cerró. */
function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

// Instalar PHP o Node tarda minutos: el renderer recibe el registro en vivo y
// un evento final, además del resultado de la promesa.
ipcMain.handle('php:install', async (e, version: string) => {
  assertTrusted(e)
  try {
    await pv.installPhpVersion(version, (text) => send('php:install-event', { type: 'log', text }))
    send('php:install-event', { type: 'done', ok: true, message: `PHP ${version} is installed.` })
  } catch (err) {
    send('php:install-event', { type: 'done', ok: false, message: err instanceof Error ? err.message : String(err) })
    throw err
  }
})

ipcMain.handle('php:update', async (e, version: string) => {
  assertTrusted(e)
  try {
    await pv.updatePhpVersion(version, (text) => send('php:install-event', { type: 'log', text }))
    send('php:install-event', { type: 'done', ok: true, message: `PHP ${version} is up to date.` })
  } catch (err) {
    send('php:install-event', { type: 'done', ok: false, message: err instanceof Error ? err.message : String(err) })
    throw err
  }
})

ipcMain.handle('php:cancel', async (e, version: string) => {
  assertTrusted(e)
  await pv.cancelPhpInstall(version)
  send('php:install-event', { type: 'done', ok: false, message: `The PHP ${version} job was cancelled.` })
})

ipcMain.handle('php:uninstall', async (e, version: string) => {
  assertTrusted(e)
  try {
    await pv.uninstallPhpVersion(version, (text) => send('php:install-event', { type: 'log', text }))
    send('php:install-event', { type: 'done', ok: true, message: `PHP ${version} was removed.` })
  } catch (err) {
    send('php:install-event', { type: 'done', ok: false, message: err instanceof Error ? err.message : String(err) })
    throw err
  }
})

ipcMain.handle('php:add-repo', async (e) => {
  assertTrusted(e)
  try {
    await pv.configurePhpRepository((text: string) => send('php:install-event', { type: 'log', text }))
    send('php:install-event', { type: 'done', ok: true, message: 'The PHP repository is configured.' })
  } catch (err) {
    send('php:install-event', { type: 'done', ok: false, message: err instanceof Error ? err.message : String(err) })
    throw err
  }
})

ipcMain.handle('node:install', async (e, major: string) => {
  assertTrusted(e)
  try {
    await nv.installNodeVersion(major, (text) => send('node:install-event', { type: 'log', text }))
    send('node:install-event', { type: 'done', ok: true, message: `Node.js ${major} is installed.` })
  } catch (err) {
    send('node:install-event', { type: 'done', ok: false, message: err instanceof Error ? err.message : String(err) })
    throw err
  }
})

ipcMain.handle('sites:pick-dir', async (e, current?: string) => {
  assertTrusted(e)
  const win = BrowserWindow.fromWebContents(e.sender)
  const options: OpenDialogOptions = {
    title: 'Choose a folder for the project',
    defaultPath: typeof current === 'string' && current.trim() ? current : undefined,
    properties: ['openDirectory', 'createDirectory']
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : result.filePaths[0] ?? null
})

/** Canal con progreso: valida el emisor y emite por el canal de eventos indicado. */
function handleWithEvents(
  channel: string,
  eventChannel: string,
  run: (send: (ev: unknown) => void, ...args: any[]) => unknown
) {
  ipcMain.handle(channel, (e, ...args) => {
    assertTrusted(e)
    const send = (ev: unknown) => { if (!e.sender.isDestroyed()) e.sender.send(eventChannel, ev) }
    return run(send, ...args)
  })
}

handleWithEvents('sites:create', 'sites:create-event', (send, o) => v.createLaravelProject(o, send))
ipcMain.handle('install:check', (e) => { assertTrusted(e); return inst.checkEnv() })
handleWithEvents('install:start', 'install:event', (send, o) => inst.startInstall(o, send))
ipcMain.handle('install:cancel', (e) => { assertTrusted(e); inst.cancelInstall() })
handleWithEvents('install:uninstall', 'install:event', (send, p, o) => inst.startUninstall(p, send, o))
handleWithEvents('install:repairDns', 'install:event', (send, m) => inst.repairDns(m, send))
handleWithEvents('install:syncHosts', 'install:event', (send) => inst.syncHosts(send))
ipcMain.handle('updates:check', (e, force?: boolean) => { assertTrusted(e); return upd.checkUpdates(force === true) })
handleWithEvents('updates:run', 'install:event', (send, id) => upd.runUpdate(id, send))
ipcMain.handle('app-update:state', (e) => { assertTrusted(e); return au.appUpdateState() })
ipcMain.handle('app-update:check', (e) => { assertTrusted(e); return au.checkAppUpdate() })
ipcMain.handle('app-update:download', (e) => { assertTrusted(e); return au.downloadAppUpdate() })
ipcMain.handle('app-update:install', async (e) => { assertTrusted(e); await au.installAppUpdate() })

au.onAppUpdate((state) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-update:event', state)
})

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 760, minHeight: 520,
    autoHideMenuBar: true,
    icon: ICON && !ICON.isEmpty() ? ICON : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  })
  mainWindow = win
  if (ICON && !ICON.isEmpty()) win.setIcon(ICON)
  win.removeMenu()

  // El preload sigue vivo aunque la ventana navegue, así que la propia ventana
  // no puede salir de la aplicación: cualquier otro destino se abre en el navegador.
  const guard = (e: Electron.Event, url: string) => {
    if (isAppUrl(url)) return
    e.preventDefault()
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
  }
  win.webContents.on('will-navigate', guard)
  win.webContents.on('will-redirect', guard)
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Cerrar la ventana es esconderla: el panel sigue en la bandeja con el
  // estado de los servicios. Salir de verdad es el Quit del menú de la bandeja
  // (o una actualización que reinicia): `quitting` lo permite.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

// La salida la piden el Quit de la bandeja o la autoactualización: entonces sí
// se cierra de verdad y la bandeja se suelta antes de que termine el proceso.
let quitting = false
app.on('before-quit', () => {
  quitting = true
  destroyTray()
  void mail.shutdownMail()
})

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  // La 0.3.x dejaba Mailpit como servicio de usuario. Se retira antes de
  // arrancar el catcher para liberar 2525/1025 y que los `.env` antiguos sigan
  // entregando correo al panel nuevo.
  await removeLegacyMailpit().catch((err) => {
    console.warn('Could not remove the previous Mailpit service:', err)
  })
  // El catcher arranca con el panel: cualquier proyecto puede enviar correo sin
  // instalar ni configurar nada más.
  await mail.initMail((event: MailEvent) => send('mail:event', event))
  createWindow()
  if (ICON && !ICON.isEmpty()) void createTray(ICON, TRAY_ICONS, () => mainWindow)
  // Se consulta en segundo plano: si hay versión nueva, el panel de
  // actualizaciones la muestra al abrirse sin bloquear el arranque ni la red.
  // La comprobación se repite cada 6 horas para una app que queda abierta.
  if (app.isPackaged) {
    setTimeout(() => { void au.checkAppUpdate() }, 4000)
    const updates = setInterval(() => { void au.checkAppUpdate() }, 6 * 60 * 60 * 1000)
    updates.unref()
  }
})
app.on('window-all-closed', () => app.quit())
