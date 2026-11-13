// Ajustes generales del entorno y resumen del panel. Todo se lee de Valet, del
// panel y de systemd; no hay una copia propia que se pueda desincronizar.

import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import type { DashboardInfo, SystemSettings } from '../shared/site'
import { run } from './exec'
import { prepareHelpers, runValet } from './helpers'
import { listServices, listSites, phpInfo, scanPorts, valetDomain, webPortConflict } from './valet'
import { defaultPhpVersion, installedPhpVersions } from './php-versions'
import { nodeVersionsInfo } from './node-versions'
import { databasesInfo } from './databases'
import { info as mailInfo } from './mail'
import { MAIL_PORT } from '../shared/mail'

const HOME = homedir()
const VALET = join(HOME, '.valet')
const APP = join(HOME, '.valet-studio')
const NVM = join(HOME, '.nvm')

interface ValetConfig { domain?: string; paths?: unknown; port?: unknown }

async function valetConfig(): Promise<ValetConfig> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(VALET, 'config.json'), 'utf8'))
    return raw && typeof raw === 'object' ? raw as ValetConfig : {}
  } catch { return {} }
}

async function appConfig(): Promise<{ http?: unknown; https?: unknown }> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(APP, 'config.json'), 'utf8'))
    return raw && typeof raw === 'object' ? raw as { http?: unknown; https?: unknown } : {}
  } catch { return {} }
}

const validPort = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535 ? v : fallback

export async function systemSettings(): Promise<SystemSettings> {
  const [config, app, php, node] = await Promise.all([
    valetConfig(),
    appConfig(),
    defaultPhpVersion(),
    nodeVersionsInfo()
  ])
  const paths = Array.isArray(config.paths)
    ? config.paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    : []
  return {
    domain: typeof config.domain === 'string' && config.domain.trim() ? config.domain.trim() : 'test',
    parkedPaths: paths,
    httpPort: validPort(app.http, 80),
    httpsPort: validPort(app.https, 443),
    defaultPhp: php,
    defaultNode: node.defaultVersion,
    dataDir: APP,
    valetHome: VALET,
    sitesDir: join(VALET, 'Sites'),
    nodeDir: NVM,
    warning: ''
  }
}

export async function setDomain(domain: string): Promise<SystemSettings> {
  const value = domain.trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)) {
    throw new Error('Invalid domain: use letters, numbers, dots and hyphens.')
  }
  if (value.length > 63) throw new Error('The domain is too long.')
  await prepareHelpers()
  await runValet(['domain', value])
  return systemSettings()
}

export async function addParkedPath(path: string): Promise<SystemSettings> {
  const value = path.trim()
  if (!value.startsWith('/')) throw new Error('Choose an absolute folder path.')
  if (!existsSync(value)) throw new Error(`The folder does not exist: ${value}`)
  await prepareHelpers()
  await runValet(['park', value])
  return systemSettings()
}

export async function removeParkedPath(path: string): Promise<SystemSettings> {
  const value = path.trim()
  if (!value.startsWith('/')) throw new Error('Invalid folder path.')
  await prepareHelpers()
  await runValet(['forget', value])
  return systemSettings()
}

export async function dashboardInfo(): Promise<DashboardInfo> {
  const [sites, services, php, node, databases, mail, domain, settings, phpVersions, ports] = await Promise.all([
    listSites(),
    listServices(),
    phpInfo(),
    nodeVersionsInfo(),
    databasesInfo(),
    mailInfo().catch(() => null),
    valetDomain(),
    systemSettings(),
    installedPhpVersions(),
    scanPorts()
  ])
  const nginx = services.find((s) => s.name === 'nginx')
  const dns = services.find((s) => /dnsmasq|valet-dns|valet-studio-dns/.test(s.name))
  // Sin nginx instalado no hay conflicto que resolver: el problema es que falta
  // el servidor web, y el Dashboard lo dice en su bloque de estado.
  const conflict = nginx ? webPortConflict(ports) : null
  const conflictEnabled = conflict
    ? (await run('systemctl', ['is-enabled', conflict.unit], true)).trim() === 'enabled'
    : false
  const warnings: string[] = []
  // nginx no se trata como un fallo genérico: la interfaz muestra el estado de
  // Valet (en marcha o no) y, si otro servidor local ocupa los puertos, explica
  // cuál es y ofrece liberarlos. Así no se mezcla «Valet está roto» con «Flock
  // está sirviendo en su lugar».
  if (!nginx && sites.length > 0) {
    warnings.push('nginx is not installed: the existing sites cannot be served. Run the installer.')
  }
  // nginx y PHP-FPM se muestran en el bloque de estado de Valet, no como un
  // aviso duplicado: el bloque ya dice si Valet puede servir sitios o no.
  if (dns && !dns.active) warnings.push(`${dns.name} is not running: .${domain} may not resolve.`)
  if (mail && !mail.running) {
    warnings.push(mail.error || 'The built-in mail catcher is not listening: apps cannot send mail to it.')
  }
  if (!sites.length) warnings.push('There are no sites yet. Create a project or park a folder.')

  return {
    sites: sites.length,
    linked: sites.filter((s) => s.kind === 'linked').length,
    parkedFolders: settings.parkedPaths.length,
    services: services.map((s) => ({ name: s.name, active: s.active })),
    web: {
      nginxInstalled: Boolean(nginx),
      nginxActive: Boolean(nginx?.active),
      fpmActive: Boolean(php.fpmActive),
      ready: Boolean(nginx?.active && php.fpmActive),
      conflict: conflict
        ? { ...conflict, enabled: conflictEnabled }
        : null
    },
    php: {
      version: php.managed || php.current,
      fpmActive: php.fpmActive,
      versions: phpVersions.length
    },
    node: {
      version: node.defaultVersion,
      versions: node.versions.length
    },
    databases: databases.servers.map((s) => ({
      engine: s.engine,
      label: s.label,
      installed: s.installed,
      active: s.active,
      databases: s.databases.length
    })),
    mail: {
      running: Boolean(mail?.running),
      messages: mail?.messages ?? 0,
      port: mail?.port ?? MAIL_PORT
    },
    dns: {
      mode: dns ? 'dnsmasq' : 'hosts',
      ok: dns ? dns.active : true,
      detail: dns ? `${dns.name} ${dns.active ? 'running' : 'stopped'}` : `Sites resolve through the hosts file (.${domain})`
    },
    warnings
  }
}

/** Comprueba que `sudo`/polkit sigue disponible antes de una acción elevada. */
export async function elevationReady(): Promise<boolean> {
  const pkexec = (await run('which', ['pkexec'], true)).trim() !== ''
  return pkexec || existsSync('/usr/bin/sudo')
}

/**
 * Abre una de las carpetas conocidas del panel. No acepta rutas libres: la
 * ventana solo puede pedir estos cuatro destinos, así un error del renderer no
 * termina abriendo cualquier ruta del sistema.
 */
export async function openKnownFolder(kind: 'data' | 'valet' | 'sites' | 'nvm'): Promise<void> {
  const dirs: Record<typeof kind, string> = {
    data: APP,
    valet: VALET,
    sites: join(VALET, 'Sites'),
    nvm: NVM
  }
  const dir = dirs[kind]
  if (!dir) throw new Error('Unknown folder')
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined)
  const error = await shell.openPath(dir)
  if (error) throw new Error(error)
}
