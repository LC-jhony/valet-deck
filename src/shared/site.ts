// Modelo compartido del detalle de un sitio y de las páginas de sistema.
// Es puro: no toca el sistema de archivos ni ejecuta comandos, así la interfaz
// y el proceso principal usan los mismos tipos y se pueden probar por separado.

import type { DatabaseDriver } from './laravel'
import type { PhpRepoState } from './php-repo'

export type SiteFramework = 'laravel' | 'php' | 'static'

/** De dónde sale la versión de PHP que sirve el sitio. */
export type PhpSource = 'isolated' | 'default'

/** De dónde sale la versión de Node de un sitio. */
export type NodeSource = 'isolated' | 'pinned' | 'default'

export interface SitePhp {
  /** Versión efectiva, p. ej. `8.5`. */
  version: string
  source: PhpSource
  /** Versiones instaladas en el equipo, ordenadas de mayor a menor. */
  installed: string[]
  /** El sitio tiene una configuración de nginx propia con su propia versión. */
  isolatedFile: string | null
  /** `.flockrc` del proyecto, si fija una versión de PHP. */
  pinnedFile: string | null
  pinnedVersion: string | null
}

export interface SiteNode {
  /** Versión efectiva, p. ej. `22` (mayor) o `22.11.0` si está fijada. */
  version: string
  source: NodeSource
  installed: string[]
  /** Archivo del proyecto que fija la versión (`.nvmrc`, `.node-version` o `.flockrc`). */
  pinnedFile: string | null
  pinnedVersion: string | null
}

export interface SiteEnvEntry {
  key: string
  /** Vacío cuando es secreto y ya tiene valor: nunca viaja al renderer. */
  value: string
  secret: boolean
  /** La clave existe en `.env`. */
  set: boolean
}

export interface SiteDatabase {
  connection: string
  host: string
  port: number
  database: string
  username: string
  /** Hay contraseña en `.env`; el valor no se expone. */
  passwordSet: boolean
  /** Resultado de probar la conexión; `null` si no se pudo probar. */
  reachable: boolean | null
  error: string
}

export interface SiteMail {
  mailer: string
  host: string
  port: number
  username: string
  encryption: string
  passwordSet: boolean
  /** Usuario SMTP normalizado; el catcher lo usa como bandeja. */
  inbox: string
  /** Bloque listo para pegar en el `.env` de Laravel. */
  envBlock: string
}

export interface QueueUnit {
  unit: string
  index: number
  active: boolean
  enabled: boolean
}

export interface SiteQueue {
  connection: string
  queues: string
  tries: number
  timeout: number
  sleep: number
  memory: number
  /** Número de procesos `queue:work` configurados. */
  workers: number
  scheduler: boolean
  units: QueueUnit[]
  schedulerUnit: QueueUnit | null
  /** systemd de usuario disponible para gestionar los procesos. */
  systemd: boolean
}

export interface SiteExtension {
  name: string
  /** Aparece en `require` de composer.json. */
  required: boolean
  enabled: boolean
  source: string
}

export interface SiteLog {
  /** Últimas líneas del registro; vacío si no hay archivo. */
  text: string
  file: string | null
  /** Bytes totales del archivo. */
  size: number
}

export interface SiteDetail {
  name: string
  path: string
  url: string
  kind: 'parked' | 'linked'
  secure: boolean
  framework: SiteFramework
  laravelVersion: string | null
  documentRoot: string
  domains: { name: string; primary: boolean }[]
  php: SitePhp
  node: SiteNode
  database: SiteDatabase | null
  mail: SiteMail | null
  queue: SiteQueue
  env: SiteEnvEntry[]
  composerPhp: string | null
  extensions: SiteExtension[]
  logs: { laravel: SiteLog; queue: SiteLog }
  warnings: string[]
}

/** Ajustes por sitio que guarda el panel (no se escriben en el proyecto). */
export interface SiteSettingsPatch {
  node?: string | null
  domains?: string[]
  queue?: Partial<Pick<SiteQueue, 'connection' | 'queues' | 'tries' | 'timeout' | 'sleep' | 'memory' | 'workers' | 'scheduler'>>
}

export interface SiteDatabaseInput {
  connection: DatabaseDriver
  host: string
  port: number
  database: string
  username: string
  /** `null` conserva la contraseña actual. */
  password: string | null
  /** Crea la base si no existe (solo MySQL, MariaDB y PostgreSQL). */
  create: boolean
}

export interface SiteMailInput {
  mailer: string
  host: string
  port: number
  username: string
  /** `null` conserva la contraseña actual. */
  password: string | null
  encryption: string
}

export interface EnvWrite {
  key: string
  /** `null` elimina la clave; una cadena vacía deja el secreto intacto. */
  value: string | null
}

/** Trabajo de instalación o actualización de una versión de PHP. */
export interface PhpInstallJob {
  action: 'install' | 'update' | 'uninstall'
  state: 'running' | 'failed'
  phase: 'installing' | 'updating' | 'removing' | 'cancelling'
  /** `-1` mientras apt no informa de un porcentaje. */
  progress: number
  error: string
  startedAt: string
}

export interface PhpVersionInfo {
  version: string
  installed: boolean
  fpmActive: boolean
  isDefault: boolean
  extensions: string[]
  /** El binario de esta versión carga Xdebug, como muestra Flock. */
  xdebug: boolean
  iniPath: string | null
  sites: string[]
  /** Versión completa instalada, p. ej. `8.4.27`. */
  patch: string | null
  /** Última versión completa que ofrece el repositorio, p. ej. `8.4.27`. */
  latest: string | null
  /** El repositorio tiene un parche más nuevo que el instalado. */
  updateAvailable: boolean
  /** Tamaño en bytes; `sizeKind` dice si es en disco o de descarga. */
  size: number | null
  sizeKind: 'installed' | 'download' | null
  /** Trabajo en curso o fallido de esta versión. */
  job: PhpInstallJob | null
  /** Archivo con el registro de la última instalación. */
  logFile: string | null
}

export interface PhpAvailableVersion {
  version: string
  latest: string | null
  /** Bytes de descarga de los paquetes y extensiones. */
  size: number | null
  /** El repositorio configurado ofrece esta versión y se puede instalar. */
  installable: boolean
  /** Por qué no se puede instalar, vacío cuando sí se puede. */
  reason: string
}

export interface PhpVersionsInfo {
  versions: PhpVersionInfo[]
  defaultVersion: string
  currentCli: string
  /** Versiones que el PPA de Ondřej ofrece y no están instaladas. */
  available: PhpAvailableVersion[]
  /** Repositorio que el panel usa para instalar PHP en esta distro. */
  repo: PhpRepoState
  warning: string
}

export interface NodeVersionInfo {
  version: string
  major: number
  npm: string | null
  path: string
  isDefault: boolean
  sites: string[]
}

export interface NodeVersionsInfo {
  versions: NodeVersionInfo[]
  defaultVersion: string
  nvm: boolean
  nvmDir: string
  warning: string
}

export type DatabaseEngine = 'mariadb' | 'mysql' | 'postgres' | 'sqlite'

export interface DatabaseEntry {
  name: string
  engine: DatabaseEngine
  size: number | null
  tables: number | null
  charset: string
  sites: string[]
}

export interface DatabaseServer {
  engine: DatabaseEngine
  label: string
  /** El servidor está instalado (no solo el cliente de línea de comandos). */
  installed: boolean
  active: boolean
  version: string | null
  port: number
  host: string
  username: string
  /** Hay credenciales guardadas para listar. */
  managed: boolean
  /** Unidad de systemd que se puede arrancar o parar desde el panel. */
  service: string
  databases: DatabaseEntry[]
  error: string
}

export interface DatabasesInfo {
  servers: DatabaseServer[]
  sqlite: { file: string; site: string; size: number }[]
}

export interface DatabaseCredentials {
  engine: DatabaseEngine
  host: string
  port: number
  username: string
  password: string
}

export interface SystemSettings {
  domain: string
  parkedPaths: string[]
  httpPort: number
  httpsPort: number
  defaultPhp: string
  defaultNode: string
  dataDir: string
  valetHome: string
  sitesDir: string
  nodeDir: string
  /** Motivo por el que algún valor no se pudo leer. */
  warning: string
}

export interface DashboardInfo {
  sites: number
  linked: number
  parkedFolders: number
  services: { name: string; active: boolean }[]
  /** Estado real del servidor web de Valet y quién ocupa sus puertos. */
  web: {
    nginxInstalled: boolean
    nginxActive: boolean
    fpmActive: boolean
    /** nginx y php-fpm están sirviendo: Valet puede abrir los sitios. */
    ready: boolean
    conflict: { unit: string; process: string; ports: number[]; enabled: boolean } | null
  }
  php: { version: string; fpmActive: boolean; versions: number }
  node: { version: string; versions: number }
  databases: { engine: DatabaseEngine; label: string; installed: boolean; active: boolean; databases: number }[]
  mail: { running: boolean; messages: number; port: number }
  dns: { mode: string; ok: boolean; detail: string }
  warnings: string[]
}

/** Evento de una tarea larga (instalar PHP, Node, etc.). */
export type TaskEvent =
  | { type: 'log'; text: string }
  | { type: 'done'; ok: boolean; message: string }
