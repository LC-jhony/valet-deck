// Ajustes por sitio que pertenecen al panel, no al proyecto: la versión de Node
// aislada, dominios extra y la configuración de los workers de cola. Se guardan
// en `~/.valet-studio/sites/<nombre>.json` con permisos 0600 porque pueden
// incluir datos de conexión. El proyecto nunca se modifica aquí.

import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SiteSettingsPatch } from '../shared/site'

const APP = join(homedir(), '.valet-studio')
const DIR = join(APP, 'sites')

export interface StoredSiteSettings {
  node: string | null
  domains: string[]
  queue: {
    connection: string
    queues: string
    tries: number
    timeout: number
    sleep: number
    memory: number
    workers: number
    scheduler: boolean
  }
}

export const defaultQueueSettings = (): StoredSiteSettings['queue'] => ({
  connection: 'database',
  queues: 'default',
  tries: 1,
  timeout: 60,
  sleep: 3,
  memory: 128,
  workers: 1,
  scheduler: false
})

const empty = (): StoredSiteSettings => ({
  node: null,
  domains: [],
  queue: defaultQueueSettings()
})

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function assertSiteName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('Invalid site name')
  return name
}

export const siteSettingsFile = (name: string): string => join(DIR, `${assertSiteName(name)}.json`)

export async function readSiteSettings(name: string): Promise<StoredSiteSettings> {
  const file = siteSettingsFile(name)
  if (!existsSync(file)) return empty()
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return empty()
  }
  if (!raw || typeof raw !== 'object') return empty()
  const c = raw as Partial<StoredSiteSettings>
  const base = empty()
  const q: Partial<StoredSiteSettings['queue']> = c.queue && typeof c.queue === 'object' ? c.queue : {}
  const num = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : fallback
  const str = (v: unknown, fallback: string, max = 120): string =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback
  return {
    node: typeof c.node === 'string' && /^\d+(?:\.\d+){0,2}$/.test(c.node) ? c.node : null,
    domains: Array.isArray(c.domains)
      ? c.domains.filter((d): d is string => typeof d === 'string' && /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(d)).slice(0, 50)
      : [],
    queue: {
      connection: str(q.connection, base.queue.connection, 40),
      queues: str(q.queues, base.queue.queues, 200),
      tries: num(q.tries, base.queue.tries, 1, 100),
      timeout: num(q.timeout, base.queue.timeout, 1, 3600),
      sleep: num(q.sleep, base.queue.sleep, 0, 600),
      memory: num(q.memory, base.queue.memory, 16, 4096),
      workers: num(q.workers, base.queue.workers, 0, 8),
      scheduler: q.scheduler === true
    }
  }
}

export async function writeSiteSettings(name: string, patch: SiteSettingsPatch): Promise<StoredSiteSettings> {
  const current = await readSiteSettings(name)
  const next: StoredSiteSettings = {
    node: patch.node === undefined ? current.node : patch.node,
    domains: patch.domains === undefined ? current.domains : patch.domains,
    queue: { ...current.queue, ...(patch.queue ?? {}) }
  }
  if (next.node !== null && !/^\d+(?:\.\d+){0,2}$/.test(next.node)) throw new Error('Invalid Node version')
  await mkdir(DIR, { recursive: true, mode: 0o700 })
  const file = siteSettingsFile(name)
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  return next
}
