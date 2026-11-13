// Node.js mediante nvm. El panel no descarga binarios por su cuenta: usa la
// instalación de nvm del usuario y sus alias, así el terminal y el panel ven
// exactamente las mismas versiones.
//
// `nvm` es una función de shell, no un binario: cada operación carga `nvm.sh`
// en un `bash` no interactivo. Las versiones se validan antes de interpolarse.

import { existsSync } from 'node:fs'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NodeVersionInfo, NodeVersionsInfo } from '../shared/site'
import { compareVersions, majorVersion } from '../shared/site-files'
import { runWithEnv } from './exec'
import { nvmAvailable, nvmDir, nvmEnv } from './nvm'
import { listSites } from './valet'
import { readSiteSettings } from './site-store'

/** Ejecuta un fragmento de shell con nvm cargado. */
async function nvm(script: string, lenient = false): Promise<string> {
  const dir = nvmDir()
  const quoted = dir.replace(/"/g, '\\"')
  const full = [
    `export NVM_DIR="${quoted}"`,
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
    script
  ].join('\n')
  return runWithEnv('bash', ['-c', full], nvmEnv(), lenient)
}

interface InstalledNode { version: string; dir: string }

async function installedNodes(): Promise<InstalledNode[]> {
  const root = join(nvmDir(), 'versions', 'node')
  const entries = await readdir(root).catch(() => [] as string[])
  return entries
    .map((name) => ({ name, version: name.replace(/^v/, '') }))
    .filter((e) => /^\d+\.\d+\.\d+$/.test(e.version))
    .map((e) => ({ version: e.version, dir: join(root, e.name) }))
    .sort((a, b) => compareVersions(b.version, a.version))
}

/** Alias `default` de nvm. Puede ser `26`, `v26.13.0` o `lts/*`. */
async function defaultAlias(): Promise<string> {
  const raw = (await readFile(join(nvmDir(), 'alias', 'default'), 'utf8').catch(() => '')).trim()
  return raw
}

function resolveAlias(alias: string, installed: InstalledNode[]): string {
  if (!alias) return installed[0]?.version ?? ''
  const clean = alias.replace(/^v/, '').trim()
  if (/^\d+\.\d+\.\d+$/.test(clean)) {
    return installed.some((n) => n.version === clean) ? clean : ''
  }
  if (/^\d+$/.test(clean)) {
    const match = installed.find((n) => n.version.split('.')[0] === clean)
    return match?.version ?? ''
  }
  // `lts/*` o `node`: la versión instalada más reciente es la mejor aproximación.
  return installed[0]?.version ?? ''
}

async function npmVersion(dir: string): Promise<string | null> {
  const out = (await runWithEnv(join(dir, 'bin', 'npm'), ['-v'], nvmEnv(), true)).trim()
  return /^\d+\.\d+\.\d+$/.test(out) ? out : null
}

async function nodeSites(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const sites = await listSites()
  for (const site of sites) {
    const settings = await readSiteSettings(site.name)
    if (!settings.node) continue
    const major = majorVersion(settings.node)
    if (!major) continue
    out.set(major, [...(out.get(major) ?? []), site.name])
  }
  return out
}

export async function nodeVersionsInfo(): Promise<NodeVersionsInfo> {
  const installed = await installedNodes()
  const [alias, sites] = await Promise.all([defaultAlias(), nodeSites()])
  const defaultVersion = resolveAlias(alias, installed)
  const versions: NodeVersionInfo[] = []
  for (const node of installed) {
    const major = node.version.split('.')[0]
    versions.push({
      version: node.version,
      major: Number(major),
      npm: await npmVersion(node.dir),
      path: node.dir,
      isDefault: node.version === defaultVersion,
      sites: sites.get(major) ?? []
    })
  }
  if (!versions.length) {
    return {
      versions: [],
      defaultVersion: '',
      nvm: nvmAvailable(),
      nvmDir: nvmDir(),
      warning: nvmAvailable()
        ? 'nvm is installed but has no Node versions yet.'
        : 'nvm is not installed. Install it from the Installation tab.'
    }
  }
  return { versions, defaultVersion, nvm: nvmAvailable(), nvmDir: nvmDir(), warning: '' }
}

/** Instala la última versión de una mayor (`22`). No cambia el alias por defecto. */
export async function installNodeVersion(major: string, log: (text: string) => void): Promise<void> {
  if (!/^\d{1,3}$/.test(major)) throw new Error('Invalid Node.js major version')
  if (!nvmAvailable()) throw new Error('nvm is not installed. Install it from the Installation tab first.')
  log(`$ nvm install ${major}\n`)
  const out = await nvm(`nvm install ${major} 2>&1`)
  if (out.trim()) log(`${out.trim()}\n`)
  if (!(await nvm(`nvm which ${major} >/dev/null 2>&1 && echo ok`, true)).includes('ok')) {
    throw new Error(`Node.js ${major} could not be installed.`)
  }
}

/** Fija la versión por defecto de nvm. */
export async function setDefaultNode(major: string): Promise<void> {
  if (!/^\d{1,3}$/.test(major)) throw new Error('Invalid Node.js version')
  if (!nvmAvailable()) throw new Error('nvm is not installed.')
  await nvm(`nvm alias default ${major}`)
}

export async function uninstallNodeVersion(version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Node.js version')
  if (!nvmAvailable()) throw new Error('nvm is not installed.')
  await nvm(`nvm uninstall v${version}`)
}

/** Escribe `.nvmrc` en el proyecto para que todo el equipo use la misma versión. */
export async function pinNodeVersion(siteName: string, version: string): Promise<string> {
  if (!/^\d+(?:\.\d+){0,2}$/.test(version)) throw new Error('Invalid Node.js version')
  const site = (await listSites()).find((s) => s.name === siteName)
  if (!site) throw new Error(`Unknown site: ${siteName}`)
  const file = join(site.path, '.nvmrc')
  await writeFile(file, `${version.replace(/^v/, '')}\n`, { mode: 0o644 })
  return file
}

/** Quita el `.nvmrc` del proyecto. Solo ese archivo, nunca `.node-version`. */
export async function unpinNodeVersion(siteName: string): Promise<void> {
  const site = (await listSites()).find((s) => s.name === siteName)
  if (!site) throw new Error(`Unknown site: ${siteName}`)
  const file = join(site.path, '.nvmrc')
  if (!existsSync(file)) return
  await rm(file)
}

/** Comprueba que un binario de Node responde, para la ficha de versión. */
export async function nodeBinaryVersion(path: string): Promise<string | null> {
  const out = (await runWithEnv(join(path, 'bin', 'node'), ['-v'], nvmEnv(), true)).trim()
  return out.replace(/^v/, '') || null
}
