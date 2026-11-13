import type { MailApi } from './mail'
import type { DatabaseConnection, LaravelAnswers, LaravelCapabilities } from './laravel'
import type {
  DashboardInfo, DatabasesInfo, DatabaseCredentials, DatabaseEngine, EnvWrite,
  NodeVersionsInfo, PhpVersionsInfo, SiteDatabaseInput, SiteDetail, SiteMailInput, SiteQueue,
  SiteSettingsPatch, SystemSettings, TaskEvent
} from './site'

export type { MailApi } from './mail'
export type { DatabaseConnection, LaravelAnswers, LaravelCapabilities } from './laravel'
export type * from './site'

export interface Site { name: string; path: string; secure: boolean; kind: 'parked' | 'linked'; url: string }

/** Usuario que el instalador crea en MariaDB para los proyectos Laravel. */
export interface MariaDbCredentials {
  host: string
  port: number
  username: string
  password: string
}

export interface ProjectInfo {
  domain: string
  parkedPaths: string[]
  defaultDir: string
  httpPort: number
  composerAvailable: boolean
  valetAvailable: boolean
  /** Instalador de Laravel (`laravel new`). Si falta, se instala al crear. */
  installer: { available: boolean; version: string | null }
  /** Opciones reales que permiten el instalador, PHP y los gestores de Node. */
  capabilities: LaravelCapabilities
  /** Credenciales gestionadas por el panel; `null` si MariaDB aún no está configurada. */
  mariadb: MariaDbCredentials | null
}
export interface CreateProjectOptions {
  /** Carpeta donde se creará el proyecto (nunca un enlace de Valet). */
  parentDir: string
  /** Respuestas del asistente, incluido el nombre del proyecto. */
  answers: LaravelAnswers
  /** Credenciales para `artisan migrate`; `null` con SQLite. */
  database: DatabaseConnection | null
}
export type CreateProjectEvent =
  | { type: 'stage'; label: string }
  | { type: 'log'; text: string }
  /** La creación falló y quedó una carpeta que el usuario puede eliminar. */
  | { type: 'incomplete'; path: string; message: string }
/** Dueño de un socket. `unit` es la unidad de systemd, si el cgroup la nombra. */
export interface PortUsage { port: number; process: string; pid: string; unit: string }
export interface ApacheInfo { installed: boolean; active: boolean; enabled: boolean; http: number | null; https: number | null }
export interface PortsInfo {
  config: { http: number; https: number }
  usage: PortUsage[]
  nginxActive: boolean
  apache: ApacheInfo
}
/**
 * Estado de la única instalación de PHP que gestiona el panel. No enumera
 * versiones. `target` es la versión que el panel instala y espera (`null` si
 * usa el PHP único de la distribución), `current` es lo que reporta el binario
 * `php` y `managed` es la versión sobre la que se calcula `installed` y
 * `fpmActive`.
 */
export interface PhpInfo {
  target: string | null
  current: string
  managed: string
  installed: boolean
  fpmActive: boolean
}
export interface Service { name: string; active: boolean }
export type ServiceAction = 'start' | 'stop' | 'restart'

/** Dynamic responde a cualquier subdominio sin tocar la red; Hosts escribe /etc/hosts. */
export type DnsMode = 'safe' | 'hosts'

export interface DnsInfo {
  domain: string
  networkManager: boolean
  resolvedActive: boolean
  dnsmasqBinary: boolean
  dnsmasqServiceActive: boolean
  dashboardActive: boolean
  port: number
  portFree: boolean
  resolvConfOk: boolean
  testResolves: boolean
  /** Hay restos del DNS clásico de Valet que el instalador puede retirar. */
  classicLeftovers: boolean
}

export interface ComposerInfo {
  available: boolean
  globalHome: string
  isolatedHome: string
  isolatedValet: boolean
  conflict: boolean
  conflictDetail: string
}

export interface ValetInfo {
  installed: boolean
  path: string | null
  version: string | null
  isolated: boolean
}

export interface NodeInfo {
  installed: boolean
  /** Versión sin la `v` inicial; vacía si Node no está en el PATH. */
  version: string
  /** nvm está instalado y el panel puede usarlo para instalar Node. */
  nvm: boolean
}

export interface MariaDbInfo {
  installed: boolean
  active: boolean
}

export interface Api {
  sites: {
    list(): Promise<Site[]>
    secure(name: string, on: boolean): Promise<void>
    /** Quita el sitio; `deleteFiles` borra también la carpeta del proyecto. */
    remove(name: string, options?: { deleteFiles?: boolean }): Promise<void>
    open(name: string): Promise<void>
    projectInfo(): Promise<ProjectInfo>
    pickDirectory(current?: string): Promise<string | null>
    create(opts: CreateProjectOptions): Promise<Site>
    cancelCreate(): Promise<void>
    /** Borra la última carpeta incompleta de una creación fallida. */
    deleteIncomplete(path: string): Promise<void>
    onCreateEvent(cb: (e: CreateProjectEvent) => void): () => void
    /** Ficha completa: versiones, base de datos, correo, colas y registros. */
    detail(name: string): Promise<SiteDetail>
    updateSettings(name: string, patch: SiteSettingsPatch): Promise<SiteDetail>
    setEnv(name: string, changes: EnvWrite[]): Promise<SiteDetail>
    setDatabase(name: string, input: SiteDatabaseInput): Promise<SiteDetail>
    applyMail(name: string): Promise<SiteDetail>
    setMail(name: string, input: SiteMailInput): Promise<SiteDetail>
    pinPhp(name: string, version: string | null): Promise<SiteDetail>
    openFolder(name: string): Promise<void>
    mailDefaults(): Promise<{ port: number; host: string }>
  }
  php: {
    list(): Promise<PhpInfo>
    versions(): Promise<PhpVersionsInfo>
    install(version: string): Promise<void>
    update(version: string): Promise<void>
    /** Cancela el trabajo en curso de esa versión. */
    cancel(version: string): Promise<void>
    /** Quita la versión y sus extensiones con apt purge. */
    uninstall(version: string): Promise<void>
    /** Últimas líneas del registro de instalación de esa versión. */
    installLog(version: string): Promise<string>
    use(version: string): Promise<void>
    isolate(name: string, version: string | null): Promise<void>
    /** Añade el repositorio PHP (PPA de Ondřej o Sury) para esta distro. */
    addRepo(): Promise<void>
    onInstallEvent(cb: (e: TaskEvent) => void): () => void
  }
  node: {
    versions(): Promise<NodeVersionsInfo>
    install(major: string): Promise<void>
    setDefault(major: string): Promise<void>
    uninstall(version: string): Promise<void>
    pin(name: string, version: string): Promise<void>
    unpin(name: string): Promise<void>
    onInstallEvent(cb: (e: TaskEvent) => void): () => void
  }
  databases: {
    info(): Promise<DatabasesInfo>
    create(engine: DatabaseEngine, name: string): Promise<void>
    drop(engine: DatabaseEngine, name: string): Promise<void>
    saveCredentials(credentials: DatabaseCredentials): Promise<void>
    test(credentials: DatabaseCredentials): Promise<string>
  }
  system: {
    settings(): Promise<SystemSettings>
    setDomain(domain: string): Promise<SystemSettings>
    addParkedPath(path: string): Promise<SystemSettings>
    removeParkedPath(path: string): Promise<SystemSettings>
    dashboard(): Promise<DashboardInfo>
    /** Abre una carpeta conocida del panel en el gestor de archivos. */
    openFolder(kind: 'data' | 'valet' | 'sites' | 'nvm'): Promise<void>
    /**
     * Para el servicio que ocupa los puertos web y arranca nginx. Solo actúa
     * sobre una unidad detectada escuchando en 80/443; la interfaz confirma
     * antes porque el otro entorno dejará de servir.
     */
    freeWebPorts(keepOff?: boolean): Promise<void>
  }
  queue: {
    apply(name: string): Promise<SiteQueue>
    stop(name: string): Promise<SiteQueue>
    logs(name: string): Promise<string>
  }
  ports: {
    scan(): Promise<PortsInfo>
    set(http: number, https: number): Promise<void>
    setApache(http: number, https: number): Promise<void>
  }
  services: {
    list(): Promise<Service[]>
    action(name: string, action: ServiceAction): Promise<void>
    /** Últimas líneas del journal de la unidad. Solo lectura. */
    logs(name: string, lines?: number): Promise<string>
  }
  mariadb: {
    /**
     * Abre `sudo mariadb-secure-installation` en una terminal del sistema y
     * devuelve cuál se usó. El asistente pide la contraseña dentro de la ventana.
     */
    secureInstall(): Promise<string>
  }
  mail: MailApi
  updates: {
    /** Consulta versiones instaladas y disponibles; `force` ignora la caché. */
    check(force?: boolean): Promise<UpdatesInfo>
    run(id: UpdateId): Promise<void>
  }
  /** Actualización del propio Valet Deck desde sus releases de GitHub. */
  appUpdate: {
    state(): Promise<AppUpdateState>
    check(): Promise<AppUpdateState>
    download(): Promise<AppUpdateState>
    install(): Promise<void>
    onEvent(cb: (state: AppUpdateState) => void): () => void
  }
  install: {
    check(): Promise<Env>
    start(opts: InstallOptions): Promise<void>
    cancel(): Promise<void>
    uninstall(pkg: string, options?: { full?: boolean }): Promise<void>
    repairDns(mode: DnsMode): Promise<void>
    syncHosts(): Promise<void>
    onEvent(cb: (e: InstallEvent) => void): () => void
  }
}

export type AppUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

/** Estado de la actualización del propio panel. */
export interface AppUpdateState {
  status: AppUpdateStatus
  /** Versión instalada. */
  current: string
  /** Última versión publicada, cuando se conoce. */
  latest: string
  /** Descarga completada, de 0 a 100. */
  percent: number
  /** Motivo legible cuando el estado es `error` o `disabled`. */
  message: string
}

/** Requisitos que el panel no puede resolver por sí mismo. */
export type PrereqId = 'systemd' | 'elevation' | 'sudo' | 'askpass' | 'packages' | 'network' | 'disk'

export interface Prereq {
  id: PrereqId
  label: string
  ok: boolean
  /** Un requisito bloqueante impide instalar hasta que se resuelva. */
  blocking: boolean
  detail: string
  /** Comandos exactos para resolverlo a mano. Vacío si ya está resuelto. */
  commands: string[]
}

export interface Env {
  distro: string
  pm: string | null
  tools: Record<string, boolean>
  portHogs: string[]
  dns: DnsInfo
  composer: ComposerInfo
  valet: ValetInfo
  /** Estado de la única versión de PHP que gestiona el panel. */
  php: PhpInfo
  node: NodeInfo
  mariadb: MariaDbInfo
  warnings: string[]
  recommendedDnsMode: DnsMode
  prereqs: Prereq[]
  /** Cómo se pedirá la contraseña de administrador. */
  elevation: 'pkexec' | 'sudo' | null
}

export interface InstallOptions {
  pkg: string
  parkDir: string
  stopApache: boolean
  dnsMode: DnsMode
  /** Instala y arranca MariaDB. */
  mariadb?: boolean
  /** Instala Node.js 26 con nvm y lo deja como versión por defecto. */
  node?: boolean
  /**
   * Ventana de primer arranque: instala los componentes sin tocar DNS.
   * El instalador de la pestaña Instalación sigue aplicando el modo elegido.
   */
  skipDns?: boolean
}

/** Programas que el panel sabe comparar y, a veces, actualizar. */
export type UpdateId = 'php' | 'nginx' | 'dnsmasq' | 'composer' | 'valet' | 'node'

export interface UpdateItem {
  id: UpdateId
  label: string
  /** Versión instalada; vacía si el programa no está. */
  current: string
  /** Última versión conocida; vacía si no se pudo consultar. */
  latest: string
  /** Hay una versión más nueva que la instalada. */
  available: boolean
  /** Quién lo actualiza. `none`: el panel solo puede explicarlo. */
  source: 'system' | 'composer' | 'none'
  /** Paquetes del gestor implicados (solo `system`). */
  packages: string[]
  /** Por qué el panel no puede actualizarlo. Vacío cuando sí puede. */
  blocked: string
  /** La actualización pedirá la contraseña de administrador. */
  needsElevation: boolean
  /** Qué ejecutar a mano cuando el panel no puede. */
  commands: string[]
}

export interface UpdatesInfo {
  items: UpdateItem[]
  /** Epoch en milisegundos de la última comprobación. */
  checkedAt: number
  /** Motivo parcial: por ejemplo, no se pudo consultar internet. */
  warning: string
}
export type StepStatus = 'wait' | 'run' | 'ok' | 'skip' | 'fail'

/** Una comprobación del resumen final de la instalación. */
export interface InstallSummaryRow {
  id: string
  label: string
  /** `skip` no es un fallo: la comprobación no pudo ejecutarse. */
  state: 'ok' | 'fail' | 'skip'
  detail: string
}

export type InstallEvent =
  | { type: 'plan'; steps: { id: string; label: string }[] }
  | { type: 'step'; id: string; status: StepStatus }
  | { type: 'log'; text: string }
  | { type: 'summary'; rows: InstallSummaryRow[] }
  | { type: 'error'; title: string; detail: string; hint: string; commands: string[] }
