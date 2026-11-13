import { contextBridge, ipcRenderer } from 'electron'
import type {
  Api, AppUpdateState, CreateProjectEvent, DatabaseCredentials, DatabaseEngine, EnvWrite,
  InstallEvent, SiteDatabaseInput, SiteMailInput, SiteSettingsPatch, TaskEvent
} from '../shared/types'
import type { MailEvent } from '../shared/mail'

const call = (ch: string, ...a: unknown[]) => ipcRenderer.invoke(ch, ...a)

const api: Api = {
  sites: {
    list: () => call('sites:list'),
    secure: (n, on) => call('sites:secure', n, on),
    remove: (n, o) => call('sites:remove', n, o),
    open: (n) => call('sites:open', n),
    projectInfo: () => call('sites:project-info'),
    pickDirectory: (current) => call('sites:pick-dir', current),
    create: (o) => call('sites:create', o),
    cancelCreate: () => call('sites:cancel-create'),
    deleteIncomplete: (p) => call('sites:delete-incomplete', p),
    onCreateEvent: (cb) => {
      const h = (_e: unknown, ev: CreateProjectEvent) => cb(ev)
      ipcRenderer.on('sites:create-event', h)
      return () => void ipcRenderer.removeListener('sites:create-event', h)
    },
    detail: (n) => call('sites:detail', n),
    updateSettings: (n, p: SiteSettingsPatch) => call('sites:update-settings', n, p),
    setEnv: (n, c: EnvWrite[]) => call('sites:set-env', n, c),
    setDatabase: (n, i: SiteDatabaseInput) => call('sites:set-database', n, i),
    applyMail: (n) => call('sites:apply-mail', n),
    setMail: (n, i: SiteMailInput) => call('sites:set-mail', n, i),
    pinPhp: (n, v) => call('sites:pin-php', n, v),
    openFolder: (n) => call('sites:open-folder', n),
    mailDefaults: () => call('sites:mail-defaults')
  },
  php: {
    list: () => call('php:list'),
    versions: () => call('php:versions'),
    install: (v) => call('php:install', v),
    update: (v) => call('php:update', v),
    cancel: (v) => call('php:cancel', v),
    uninstall: (v) => call('php:uninstall', v),
    installLog: (v) => call('php:install-log', v),
    use: (v) => call('php:use', v),
    isolate: (n, v) => call('php:isolate', n, v),
    addRepo: () => call('php:add-repo'),
    onInstallEvent: (cb) => {
      const h = (_e: unknown, ev: TaskEvent) => cb(ev)
      ipcRenderer.on('php:install-event', h)
      return () => void ipcRenderer.removeListener('php:install-event', h)
    }
  },
  node: {
    versions: () => call('node:versions'),
    install: (m) => call('node:install', m),
    setDefault: (m) => call('node:set-default', m),
    uninstall: (v) => call('node:uninstall', v),
    pin: (n, v) => call('node:pin', n, v),
    unpin: (n) => call('node:unpin', n),
    onInstallEvent: (cb) => {
      const h = (_e: unknown, ev: TaskEvent) => cb(ev)
      ipcRenderer.on('node:install-event', h)
      return () => void ipcRenderer.removeListener('node:install-event', h)
    }
  },
  databases: {
    info: () => call('databases:info'),
    create: (engine: DatabaseEngine, name: string) => call('databases:create', engine, name),
    drop: (engine: DatabaseEngine, name: string) => call('databases:drop', engine, name),
    saveCredentials: (c: DatabaseCredentials) => call('databases:save-credentials', c),
    test: (c: DatabaseCredentials) => call('databases:test', c)
  },
  system: {
    settings: () => call('system:settings'),
    setDomain: (d) => call('system:set-domain', d),
    addParkedPath: (p) => call('system:add-parked', p),
    removeParkedPath: (p) => call('system:remove-parked', p),
    dashboard: () => call('system:dashboard'),
    openFolder: (k) => call('system:open-folder', k),
    /** Para el servicio que ocupa 80/443 y arranca nginx. */
    freeWebPorts: (keepOff?: boolean) => call('system:free-web-ports', keepOff)
  },
  queue: {
    apply: (n) => call('queue:apply', n),
    stop: (n) => call('queue:stop', n),
    logs: (n) => call('queue:logs', n)
  },
  ports: {
    scan: () => call('ports:scan'),
    set: (h, s) => call('ports:set', h, s),
    setApache: (h, s) => call('ports:setApache', h, s)
  },
  services: {
    list: () => call('services:list'),
    action: (n, a) => call('services:action', n, a),
    logs: (n, lines) => call('services:logs', n, lines)
  },
  mariadb: { secureInstall: () => call('mariadb:secure-install') },
  mail: {
    info: () => call('mail:info'),
    list: (inbox) => call('mail:list', inbox),
    get: (id) => call('mail:get', id),
    remove: (id) => call('mail:remove', id),
    clear: (inbox) => call('mail:clear', inbox),
    saveAttachment: (id, index) => call('mail:saveAttachment', id, index),
    configureEnv: (site) => call('mail:configureEnv', site),
    sendTest: (to, inbox) => call('mail:sendTest', to, inbox),
    openData: () => call('mail:openData'),
    onEvent: (cb) => {
      const h = (_e: unknown, ev: MailEvent) => cb(ev)
      ipcRenderer.on('mail:event', h)
      return () => void ipcRenderer.removeListener('mail:event', h)
    }
  },
  updates: {
    check: (force) => call('updates:check', force),
    run: (id) => call('updates:run', id)
  },
  appUpdate: {
    state: () => call('app-update:state'),
    check: () => call('app-update:check'),
    download: () => call('app-update:download'),
    install: () => call('app-update:install'),
    onEvent: (cb) => {
      const h = (_e: unknown, state: AppUpdateState) => cb(state)
      ipcRenderer.on('app-update:event', h)
      return () => void ipcRenderer.removeListener('app-update:event', h)
    }
  },
  install: {
    check: () => call('install:check'),
    start: (o) => call('install:start', o),
    cancel: () => call('install:cancel'),
    uninstall: (p, o) => call('install:uninstall', p, o),
    repairDns: (m) => call('install:repairDns', m),
    syncHosts: () => call('install:syncHosts'),
    onEvent: (cb) => {
      const h = (_e: unknown, ev: InstallEvent) => cb(ev)
      ipcRenderer.on('install:event', h)
      return () => void ipcRenderer.removeListener('install:event', h)
    }
  }
}
contextBridge.exposeInMainWorld('api', api)
