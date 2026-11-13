// Workers de cola y planificador de Laravel como servicios de usuario.
//
// Cada sitio puede tener N procesos `queue:work` y un `schedule:work`. Se
// gestionan con systemd de usuario (`systemctl --user`), así arrancan con la
// sesión, se reinician solos y sus registros van a un archivo del panel. No se
// escribe nada dentro del proyecto ni se pide root.

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { QueueUnit, SiteQueue } from '../shared/site'
import { run } from './exec'
import { listSites, valetDomain } from './valet'
import { readSiteSettings, type StoredSiteSettings } from './site-store'
import { isolatedSites } from './php-versions'

const HOME = homedir()
const UNIT_DIR = join(HOME, '.config', 'systemd', 'user')
const LOG_DIR = join(HOME, '.valet-studio', 'logs')
const PREFIX = 'valet-studio'

export async function userSystemd(): Promise<boolean> {
  const out = await run('systemctl', ['--user', 'show-environment'], true)
  return out.includes('PATH=') || out.includes('LANG=')
}

const safeName = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, '-')

export const queueUnitName = (site: string, index: number): string =>
  `${PREFIX}-queue-${safeName(site)}-${index}.service`

export const scheduleUnitName = (site: string): string =>
  `${PREFIX}-schedule-${safeName(site)}.service`

export const queueLogFile = (site: string): string => join(LOG_DIR, `${safeName(site)}-queue.log`)

function phpBinary(sitePath: string, version: string | null): string {
  if (version && existsSync(`/usr/bin/php${version}`)) return `/usr/bin/php${version}`
  return 'php'
}

function queueArgs(settings: StoredSiteSettings['queue']): string[] {
  const args = ['artisan', 'queue:work', `--queue=${settings.queues}`, `--tries=${settings.tries}`,
    `--timeout=${settings.timeout}`, `--sleep=${settings.sleep}`, `--memory=${settings.memory}`]
  // La conexión se pasa explícitamente: el `.env` puede cambiar después y el
  // worker debe seguir usando la que el usuario configuró en el panel.
  args.push(`--connection=${settings.connection}`)
  return args
}

/** Valida lo que se interpola en la unidad de systemd. */
export function validateQueue(settings: StoredSiteSettings['queue']): void {
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(settings.connection)) throw new Error('Invalid queue connection')
  if (!/^[A-Za-z0-9_,.*-]{1,200}$/.test(settings.queues)) throw new Error('Invalid queue names')
  for (const [key, value, min, max] of [
    ['tries', settings.tries, 1, 100],
    ['timeout', settings.timeout, 1, 3600],
    ['sleep', settings.sleep, 0, 600],
    ['memory', settings.memory, 16, 4096],
    ['workers', settings.workers, 0, 8]
  ] as const) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`)
  }
}

function workerUnit(site: string, sitePath: string, version: string | null, settings: StoredSiteSettings['queue'], index: number): string {
  const log = queueLogFile(site)
  const binary = phpBinary(sitePath, version)
  return `[Unit]
Description=Valet Deck queue worker for ${site} (${index})
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${sitePath}
ExecStart=${binary} ${queueArgs(settings).join(' ')}
Restart=always
RestartSec=3
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`
}

function scheduleUnit(site: string, sitePath: string, version: string | null): string {
  const log = queueLogFile(site)
  const binary = phpBinary(sitePath, version)
  return `[Unit]
Description=Valet Deck scheduler for ${site}
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${sitePath}
ExecStart=${binary} artisan schedule:work
Restart=always
RestartSec=30
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`
}

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  const current = await readFile(file, 'utf8').catch(() => null)
  if (current === content) return false
  await writeFile(file, content, { mode: 0o644 })
  return true
}

async function systemctl(args: string[]): Promise<string> {
  return run('systemctl', ['--user', ...args], true)
}

async function unitStates(names: string[]): Promise<Map<string, { active: boolean; enabled: boolean }>> {
  const out = new Map<string, { active: boolean; enabled: boolean }>()
  if (!names.length) return out
  const [active, enabled] = await Promise.all([
    systemctl(['is-active', ...names]),
    systemctl(['is-enabled', ...names])
  ])
  const a = active.trim().split('\n')
  const e = enabled.trim().split('\n')
  names.forEach((name, i) => out.set(name, { active: a[i] === 'active', enabled: e[i] === 'enabled' }))
  return out
}

/** Estado actual de los workers de un sitio. */
export async function queueState(name: string, settings: StoredSiteSettings['queue']): Promise<SiteQueue> {
  const systemd = await userSystemd()
  const units: QueueUnit[] = []
  if (systemd) {
    const names = Array.from({ length: settings.workers }, (_, i) => queueUnitName(name, i + 1))
    const states = await unitStates(names)
    names.forEach((unit, i) => {
      const state = states.get(unit) ?? { active: false, enabled: false }
      units.push({ unit, index: i + 1, ...state })
    })
  }
  const schedulerName = scheduleUnitName(name)
  const schedulerState = systemd ? (await unitStates([schedulerName])).get(schedulerName) : undefined
  return {
    connection: settings.connection,
    queues: settings.queues,
    tries: settings.tries,
    timeout: settings.timeout,
    sleep: settings.sleep,
    memory: settings.memory,
    workers: settings.workers,
    scheduler: settings.scheduler,
    units,
    schedulerUnit: settings.scheduler
      ? {
          unit: schedulerName,
          index: 0,
          active: schedulerState?.active ?? false,
          enabled: schedulerState?.enabled ?? false
        }
      : null,
    systemd
  }
}

/**
 * Aplica la configuración: escribe las unidades, arranca las que faltan y
 * detiene y elimina las que sobran. `enabled` las deja activas al iniciar sesión.
 */
export async function applyQueue(name: string): Promise<SiteQueue> {
  const settings = (await readSiteSettings(name)).queue
  validateQueue(settings)
  const systemd = await userSystemd()
  if (!systemd) {
    throw new Error('systemd user services are not available in this session. Queue workers need a desktop session with systemd.')
  }
  const site = (await listSites()).find((s) => s.name === name)
  if (!site) throw new Error(`Unknown site: ${name}`)
  if (!existsSync(join(site.path, 'artisan'))) throw new Error('This site is not a Laravel project: artisan was not found.')
  const domain = await valetDomain()
  const isolated = await isolatedSites(domain)
  const version = isolated.get(name) ?? null

  await mkdir(UNIT_DIR, { recursive: true })
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 })

  const wanted = new Set<string>()
  let changed = false
  for (let i = 1; i <= settings.workers; i++) {
    const unit = queueUnitName(name, i)
    wanted.add(unit)
    changed = (await writeIfChanged(join(UNIT_DIR, unit),
      workerUnit(name, site.path, version, settings, i))) || changed
  }
  const scheduleName = scheduleUnitName(name)
  if (settings.scheduler) {
    wanted.add(scheduleName)
    changed = (await writeIfChanged(join(UNIT_DIR, scheduleName),
      scheduleUnit(name, site.path, version))) || changed
  }

  // Unidades antiguas de este sitio que ya no se usan.
  const existing = await listOwnUnits(name)
  for (const unit of existing) {
    if (wanted.has(unit)) continue
    await systemctl(['stop', unit])
    await systemctl(['disable', unit])
    await rm(join(UNIT_DIR, unit), { force: true })
    changed = true
  }

  if (changed) await systemctl(['daemon-reload'])

  for (const unit of wanted) {
    // `enable --now` deja la unidad arrancada y habilitada sin dos comandos.
    await systemctl(['enable', '--now', unit])
  }
  // Los workers que se hayan reducido se detienen antes de borrar la unidad.
  for (const unit of existing) {
    if (wanted.has(unit)) continue
    await systemctl(['reset-failed', unit])
  }

  return queueState(name, settings)
}

async function listOwnUnits(name: string): Promise<string[]> {
  const prefix = `${PREFIX}-queue-${safeName(name)}-`
  const schedule = scheduleUnitName(name)
  const files = await readdir(UNIT_DIR).catch(() => [] as string[])
  return files.filter((f) => f.startsWith(prefix) || f === schedule)
}

/** Detiene y elimina todos los procesos de un sitio. */
export async function stopQueue(name: string): Promise<SiteQueue> {
  const existing = await listOwnUnits(name)
  for (const unit of existing) {
    await systemctl(['stop', unit])
    await systemctl(['disable', unit])
    await rm(join(UNIT_DIR, unit), { force: true })
  }
  if (existing.length) await systemctl(['daemon-reload'])
  return queueState(name, (await readSiteSettings(name)).queue)
}

/** Últimas líneas del registro de colas del sitio. */
export async function queueLog(name: string, lines = 200): Promise<string> {
  const file = queueLogFile(name)
  if (!existsSync(file)) return ''
  const out = await run('tail', ['-n', String(Math.max(1, Math.min(2000, lines))), file], true)
  return out
}

/** `journalctl` como alternativa cuando el archivo aún no existe. */
export async function journalLog(name: string, lines = 100): Promise<string> {
  const unit = queueUnitName(name, 1)
  return systemctl(['status', unit, '--no-pager', '-n', String(Math.max(1, Math.min(2000, lines)))])
}
