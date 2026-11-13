// Versiones de PHP instaladas en el sistema y aislamiento por sitio.
//
// El panel no descarga binarios propios: usa los paquetes de la distribución o
// del PPA de Ondřej, igual que el resto del instalador. Valet Linux ya sabe
// aislar un sitio (`valet isolate`), así que aquí solo se orquesta y se lee el
// estado real: qué versiones hay, cuál es la de por defecto, qué sitios usan
// cada una y qué extensiones tiene cada binario.

import { existsSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { mkdir, readFile, readdir, readlink, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PhpInstallJob, PhpVersionInfo, PhpVersionsInfo } from '../shared/site'
import { hasPhpUpdate, parseAptPolicy, parseAptShowSize, phpMinorFromPackage, phpPatch } from '../shared/php'
import { compareVersions, isolatedSiteName, isolatedPhpVersion } from '../shared/site-files'
import { run } from './exec'
import { elevated } from './elevate'
import { prepareHelpers, runValet } from './helpers'
import { valetDomain } from './valet'
import { APT_ENV, installArgs, PHP_EXTENSIONS, type Pm } from './prereqs'
import { addPhpRepository, ensureAptPhpRepository, phpRepoState, plainRunner } from './php-repo'

const HOME = homedir()
const VALET = join(HOME, '.valet')
const NGINX_DIR = join(VALET, 'Nginx')
const LOG_DIR = join(HOME, '.valet-studio', 'logs')

/** Versiones que el panel ofrece aunque el repositorio aún no las tenga. */
const KNOWN_VERSIONS = ['8.5', '8.4', '8.3', '8.2', '8.1', '8.0', '7.4']

/** Trabajos en curso o fallidos de esta sesión, como los `job` de Flock. */
const jobs = new Map<string, PhpInstallJob>()

/** Cómo cancelar el trabajo de cada versión: matar el proceso de apt en curso. */
const cancels = new Map<string, () => void>()

/** Versiones cuyo trabajo se pidió cancelar: su `catch` no debe revivirlo. */
const cancelRequests = new Set<string>()

/** `apt-cache` con salida en inglés: sus campos se clasifican por texto. */
const aptCache = (args: string[]): Promise<string> =>
  run('env', [...APT_ENV, 'apt-cache', ...args], true)

export function phpInstallLogFile(version: string): string | null {
  const file = join(LOG_DIR, `php-${version}-install.log`)
  return existsSync(file) ? file : null
}

export async function phpInstallLog(version: string): Promise<string> {
  if (!/^\d+\.\d+$/.test(version)) throw new Error('Invalid PHP version')
  const text = await readFile(join(LOG_DIR, `php-${version}-install.log`), 'utf8').catch(() => '')
  return text.split(/\r?\n/).slice(-400).join('\n')
}

export async function updatePhpVersion(version: string, log: (text: string) => void): Promise<void> {
  await installPhpVersion(version, log, 'update')
}

const versionFromDir = (name: string): string | null => {
  const m = name.match(/^(\d+\.\d+)$/)
  return m ? m[1] : null
}

export async function installedPhpVersions(): Promise<string[]> {
  const dirs = await readdir('/etc/php').catch(() => [] as string[])
  const fromEtc = dirs.map(versionFromDir).filter((v): v is string => Boolean(v))
  const bins = await readdir('/usr/bin').catch(() => [] as string[])
  const fromBin = bins
    .map((b) => b.match(/^php(\d+\.\d+)$/)?.[1])
    .filter((v): v is string => Boolean(v))
  return [...new Set([...fromEtc, ...fromBin])].sort((a, b) => compareVersions(b, a))
}

/** Versión que sirve el socket global de Valet: `valet85.sock` → `8.5`. */
export async function defaultPhpVersion(): Promise<string> {
  try {
    const target = await readlink(join(VALET, 'valet.sock'))
    const m = target.match(/valet(\d)(\d)\.sock/)
    if (m) return `${m[1]}.${m[2]}`
  } catch { /* sin enlace */ }
  const out = (await run('php', ['-r', 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;'], true)).trim()
  return /^\d+\.\d+$/.test(out) ? out : ''
}

async function fpmActive(version: string): Promise<boolean> {
  return (await run('systemctl', ['is-active', `php${version}-fpm`], true)).trim() === 'active'
}

async function extensionsOf(version: string): Promise<string[]> {
  const out = (await run(`/usr/bin/php${version}`, ['-m'], true)) || ''
  if (out.trim()) {
    return out
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith('[') && !l.includes(' '))
  }
  // Sin binario CLI se puede preguntar al FPM, aunque es más lento.
  const fpm = (await run(`/usr/sbin/php-fpm${version}`, ['-m'], true)) || ''
  return fpm.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean)
}

async function iniPath(version: string): Promise<string | null> {
  for (const file of [`/etc/php/${version}/fpm/php.ini`, `/etc/php/${version}/cli/php.ini`]) {
    if (existsSync(file)) return file
  }
  return null
}

/** Sitios aislados: nombre → versión, leyendo las configuraciones de nginx. */
export async function isolatedSites(domain: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const files = await readdir(NGINX_DIR).catch(() => [] as string[])
  for (const file of files) {
    const content = await readFile(join(NGINX_DIR, file), 'utf8').catch(() => '')
    const version = isolatedPhpVersion(content)
    if (!version) continue
    const name = isolatedSiteName(file, domain)
    if (name) out.set(name, version)
  }
  return out
}

/** Archivo que aísla un sitio; Valet Linux lo escribe con o sin `.conf`. */
export function isolatedSiteConfig(name: string, domain: string): string | null {
  for (const file of [`${name}.${domain}.conf`, `${name}.${domain}`]) {
    const path = join(NGINX_DIR, file)
    if (existsSync(path)) return path
  }
  return null
}

/** Versiones que el repositorio ofrece y versiones conocidas que no publica. */
async function availableVersions(installed: string[]): Promise<{ installable: string[]; unavailable: string[] }> {
  const out = await aptCache(['search', '--names-only', '^php[0-9]+\\.[0-9]+-fpm$'])
  const found = out
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .map((pkg) => phpMinorFromPackage(pkg ?? ''))
    .filter((v): v is string => Boolean(v))
  const offered = [...new Set(found)].filter((v) => !installed.includes(v))
  const unavailable = KNOWN_VERSIONS.filter((v) => !installed.includes(v) && !offered.includes(v))
  return {
    installable: offered.sort((a, b) => compareVersions(b, a)),
    unavailable
  }
}

/** Parche que está sirviendo el binario de una versión instalada. */
async function installedPatch(version: string): Promise<string | null> {
  const cli = await run(`/usr/bin/php${version}`, ['-r', 'echo PHP_VERSION;'], true)
  const fromCli = phpPatch(cli)
  if (fromCli) return fromCli
  const dpkg = await run('dpkg-query', ['-W', '-f=${Version}', `php${version}-fpm`], true)
  return phpPatch(dpkg)
}

/** Candidato de apt para cada versión, en una sola consulta. */
async function phpPolicy(versions: string[]): Promise<Map<string, { installed: string; candidate: string }>> {
  if (!versions.length) return new Map()
  const out = await aptCache(['policy', ...versions.map((v) => `php${v}-fpm`)])
  return parseAptPolicy(out)
}

/** Bytes que hay que descargar para instalar una versión y sus extensiones. */
async function downloadSize(version: string): Promise<number | null> {
  const packages = await phpPackages(version)
  if (!packages.length) return null
  const out = await aptCache(['show', '--no-all-versions', ...packages])
  const sizes = parseAptShowSize(out)
  if (!sizes.size) return null
  let total = 0
  for (const size of sizes.values()) total += size
  return total
}

/**
 * Lista de paquetes que dpkg tiene de una versión, para purgarla entera:
 * `php8.4` además de cada `php8.4-*` (cli, fpm y extensiones).
 */
export function phpPackagesFromDpkg(version: string, dpkgOutput: string): string[] {
  if (!/^\d+\.\d+$/.test(version)) throw new Error('Invalid PHP version')
  const found = new Set<string>()
  for (const line of dpkgOutput.split('\n')) {
    const name = line.trim().split(/\s+/)[0]
    if (!name) continue
    if (name === `php${version}` || name.startsWith(`php${version}-`)) found.add(name)
  }
  return [...found].sort()
}

/** Motivo por el que no se puede quitar una versión; `null` si se puede. */
export function removeBlocker(
  version: string,
  defaultVersion: string,
  sites: string[],
  job: PhpInstallJob | null
): string | null {
  if (version === defaultVersion) {
    return 'It is the version Valet serves by default. Choose another default first.'
  }
  if (sites.length > 0) {
    return `Sites are still isolated on PHP ${version}: ${sites.join(', ')}. Unpin them first.`
  }
  if (job?.state === 'running') return 'A job is running for this version.'
  return null
}

export async function phpVersionsInfo(domain = 'test'): Promise<PhpVersionsInfo> {
  const installed = await installedPhpVersions()
  const repo = await phpRepoState()
  const [current, isolated, available] = await Promise.all([
    defaultPhpVersion(),
    isolatedSites(domain),
    availableVersions(installed)
  ])
  const sitesByVersion = new Map<string, string[]>()
  for (const [site, version] of isolated) {
    sitesByVersion.set(version, [...(sitesByVersion.get(version) ?? []), site])
  }
  const catalog = [...new Set([...installed, ...available.installable, ...sitesByVersion.keys()])]
  const policy = await phpPolicy(catalog)
  const versions: PhpVersionInfo[] = []
  for (const version of installed) {
    const [fpm, exts, ini, patch, size] = await Promise.all([
      fpmActive(version), extensionsOf(version), iniPath(version), installedPatch(version), phpVersionSize(version)
    ])
    const latest = phpPatch(policy.get(`php${version}-fpm`)?.candidate ?? '')
    versions.push({
      version,
      installed: true,
      fpmActive: fpm,
      isDefault: version === current,
      extensions: exts,
      xdebug: exts.includes('xdebug'),
      iniPath: ini,
      sites: sitesByVersion.get(version) ?? [],
      patch,
      latest,
      updateAvailable: hasPhpUpdate(patch, latest),
      size,
      sizeKind: 'installed',
      job: jobs.get(version) ?? null,
      logFile: phpInstallLogFile(version)
    })
  }
  // Una versión aislada que ya no está instalada también se muestra: es un
  // problema real que el usuario debe ver, no algo que ocultar.
  for (const [version, sites] of sitesByVersion) {
    if (versions.some((v) => v.version === version)) continue
    const latest = phpPatch(policy.get(`php${version}-fpm`)?.candidate ?? '')
    versions.push({
      version, installed: false, fpmActive: false, isDefault: false,
      extensions: [], xdebug: false, iniPath: null, sites,
      patch: null, latest, updateAvailable: false,
      size: null, sizeKind: null,
      job: jobs.get(version) ?? null, logFile: phpInstallLogFile(version)
    })
  }
  versions.sort((a, b) => compareVersions(b.version, a.version))
  const availableInfo: PhpVersionsInfo['available'] = [
    ...await Promise.all(available.installable.map(async (version) => ({
      version,
      latest: phpPatch(policy.get(`php${version}-fpm`)?.candidate ?? ''),
      size: await downloadSize(version),
      installable: true,
      reason: ''
    }))),
    ...available.unavailable.map((version) => ({
      version,
      latest: null,
      size: null,
      installable: false,
      reason: repo.kind && !repo.enabled
        ? 'Add the PHP repository above to make this version installable.'
        : repo.kind
          ? `${repo.label} does not publish PHP ${version} for this release.`
          : `This Ubuntu release does not publish PHP ${version}; the panel installs only what its repositories offer.`
    }))
  ]
  return {
    versions,
    defaultVersion: current,
    currentCli: (await run('php', ['-r', 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;'], true)).trim(),
    available: availableInfo,
    repo,
    warning: ''
  }
}

/** Paquetes de una versión concreta que el repositorio sí ofrece. */
async function phpPackages(version: string): Promise<string[]> {
  const wanted = [
    `php${version}`,
    `php${version}-cli`,
    `php${version}-common`,
    `php${version}-fpm`,
    ...PHP_EXTENSIONS
      .filter((e) => !['cli', 'common', 'fpm'].includes(e))
      .map((e) => `php${version}-${e}`),
    `php${version}-bcmath`,
    `php${version}-redis`
  ]
  const unique = [...new Set(wanted)]
  const policy = await aptCache(['policy', ...unique])
  const present = new Set<string>()
  let current = ''
  for (const line of policy.split('\n')) {
    const name = line.match(/^(\S+):\s*$/)
    if (name) current = name[1]
    else if (current && /Candidate:\s*\S+/.test(line) && !/Candidate:\s*\(none\)/.test(line)) {
      present.add(current)
      current = ''
    }
  }
  return unique.filter((pkg) => present.has(pkg))
}

/**
 * Instala o actualiza una versión de PHP con sus extensiones. Usa el mismo
 * `apt-get` con timeouts y salida en inglés que el instalador principal.
 */
export async function installPhpVersion(
  version: string,
  log: (text: string) => void,
  action: 'install' | 'update' = 'install'
): Promise<void> {
  if (!/^\d+\.\d+$/.test(version)) throw new Error('Invalid PHP version')
  const installed = (await installedPhpVersions()).includes(version)
  if (action === 'install' && installed && (await fpmActive(version))) {
    log(`PHP ${version} is already installed.\n`)
    return
  }
  const pm = (existsSync('/usr/bin/apt-get') ? 'apt' : null) as Pm | null
  if (!pm) throw new Error('This system does not use apt. Install PHP with your package manager.')

  const startedAt = new Date().toISOString()
  const job: PhpInstallJob = {
    action,
    state: 'running',
    phase: action === 'update' ? 'updating' : 'installing',
    progress: -1,
    error: '',
    startedAt
  }
  jobs.set(version, job)
  cancelRequests.delete(version)
  let text = ''
  const emit = (chunk: string) => {
    text += chunk
    log(chunk)
  }
  let child: ChildProcess | null = null
  // Cancelar es matar este apt en curso, como el `cancel` de Flock: sudo
  // reenvía la señal al comando y pkexec es el propio proceso. Mientras aún
  // no hay proceso (preparar el repositorio), la bandera corta al terminar.
  cancels.set(version, () => {
    cancelRequests.add(version)
    job.phase = 'cancelling'
    emit('\n[cancelled by user]\n')
    child?.kill('SIGTERM')
  })
  const checkCancel = () => {
    if (cancelRequests.has(version)) throw new Error('Cancelled.')
  }
  try {
    if (action === 'update') emit(`Updating PHP ${version}…\n`)
    // Si el repositorio no ofrece esta versión, se añade el que corresponda a
    // la distro (PPA en LTS, Sury en versiones nuevas). `skip` significa que
    // ya estaba: solo hace falta refrescar los índices.
    const ensured = await ensureAptPhpRepository(version, plainRunner(emit))
    checkCancel()
    if (ensured === 'skip') {
      emit(`$ apt-get update\n`)
      await elevated('env', ['LC_ALL=C', 'LANGUAGE=C', 'DEBIAN_FRONTEND=noninteractive', 'apt-get',
        '-o', 'DPkg::Lock::Timeout=120', '-o', 'Acquire::http::Timeout=30',
        '-o', 'Acquire::https::Timeout=30', '-o', 'Acquire::Retries=3', 'update'])
      checkCancel()
    }
    const packages = await phpPackages(version)
    checkCancel()
    if (!packages.length) throw new Error(`PHP ${version} is not available in the configured repositories.`)
    emit(`$ apt-get install ${packages.join(' ')}\n`)
    const { cmd, args } = installArgs(pm, packages)
    await elevated(cmd, args, (c) => { child = c })
    checkCancel()
    await elevated('systemctl', ['enable', '--now', `php${version}-fpm`]).catch(() => '')
    if (action === 'update') await elevated('systemctl', ['restart', `php${version}-fpm`]).catch(() => '')
    if (!(await fpmActive(version))) throw new Error(`PHP ${version} was installed but php${version}-fpm is not running.`)
    emit(action === 'update' ? `PHP ${version} updated and php${version}-fpm is running.\n` : `PHP ${version} installed and php${version}-fpm is running.\n`)
    jobs.delete(version)
  } catch (e) {
    // Si lo canceló el usuario, `cancelPhpInstall` repara dpkg y borra el
    // trabajo: no lo resucitamos como fallo.
    if (!cancelRequests.has(version)) {
      job.state = 'failed'
      job.error = e instanceof Error ? e.message : String(e)
      emit(`[failed] ${job.error}\n`)
    }
    throw e
  } finally {
    cancels.delete(version)
    cancelRequests.delete(version)
    await mkdir(LOG_DIR, { recursive: true, mode: 0o700 }).catch(() => '')
    await writeFile(join(LOG_DIR, `php-${version}-install.log`), text, { mode: 0o600 }).catch(() => '')
  }
}

/** Cambia la versión global que sirve Valet. */
export async function usePhpVersion(version: string): Promise<void> {
  if (!/^\d+\.\d+$/.test(version)) throw new Error('Invalid PHP version')
  await prepareHelpers()
  await runValet(['use', version])
}

/**
 * Cancela el trabajo en curso de una versión, igual que el `cancel` de Flock.
 * `apt` interrumpido puede dejar paquetes a medio configurar: se reparen con
 * `dpkg --configure -a` para que el siguiente intento no herede el bloqueo.
 */
export async function cancelPhpInstall(version: string): Promise<void> {
  const job = jobs.get(version)
  if (!job || job.state !== 'running') throw new Error(`No job is running for PHP ${version}`)
  const cancel = cancels.get(version)
  if (!cancel) throw new Error(`PHP ${version} cannot be cancelled right now`)
  cancel()
  job.state = 'failed'
  job.error = 'Cancelled.'
  jobs.set(version, job)
  await elevated('dpkg', ['--configure', '-a']).catch(() => '')
  jobs.delete(version)
}

/**
 * Quita una versión de PHP y sus extensiones con `apt-get purge`. Los paquetes
 * se enumeran con dpkg (nada de patrones en el shell) y la versión tiene que
 * estar libre: ni por defecto ni con sitios aislados ni con un trabajo en curso.
 */
export async function uninstallPhpVersion(
  version: string,
  log: (text: string) => void
): Promise<void> {
  if (!/^\d+\.\d+$/.test(version)) throw new Error('Invalid PHP version')
  const info = await phpVersionsInfo()
  const current = info.versions.find((v) => v.version === version)
  if (!current || !current.installed) throw new Error(`PHP ${version} is not installed`)
  const blocker = removeBlocker(version, info.defaultVersion, current.sites, current.job)
  if (blocker) throw new Error(blocker)

  const pm = (existsSync('/usr/bin/apt-get') ? 'apt' : null) as Pm | null
  if (!pm) throw new Error('This system does not use apt. Remove PHP with your package manager.')

  const startedAt = new Date().toISOString()
  const job: PhpInstallJob = {
    action: 'uninstall',
    state: 'running',
    phase: 'removing',
    progress: -1,
    error: '',
    startedAt
  }
  jobs.set(version, job)
  cancelRequests.delete(version)
  let text = ''
  const emit = (chunk: string) => {
    text += chunk
    log(chunk)
  }
  let child: ChildProcess | null = null
  cancels.set(version, () => {
    cancelRequests.add(version)
    job.phase = 'cancelling'
    emit('\n[cancelled by user]\n')
    child?.kill('SIGTERM')
  })
  const checkCancel = () => {
    if (cancelRequests.has(version)) throw new Error('Cancelled.')
  }
  try {
    const dpkg = await run('dpkg-query', ['-W', '-f=${Package}\n', `php${version}-*`], true)
    const exact = await run('dpkg-query', ['-W', '-f=${Package}\n', `php${version}`], true)
    checkCancel()
    const packages = phpPackagesFromDpkg(version, `${dpkg}\n${exact}`)
    if (!packages.length) throw new Error(`No apt packages found for PHP ${version}`)
    emit(`$ apt-get purge ${packages.join(' ')}\n`)
    await elevated(pm, ['-o', 'DPkg::Lock::Timeout=120', 'purge', '-y', ...packages], (c) => { child = c })
    checkCancel()
    emit(`PHP ${version} removed.\n`)
    jobs.delete(version)
  } catch (e) {
    if (!cancelRequests.has(version)) {
      job.state = 'failed'
      job.error = e instanceof Error ? e.message : String(e)
      emit(`[failed] ${job.error}\n`)
    }
    throw e
  } finally {
    cancels.delete(version)
    cancelRequests.delete(version)
    await mkdir(LOG_DIR, { recursive: true, mode: 0o700 }).catch(() => '')
    const file = join(LOG_DIR, `php-${version}-install.log`)
    const previous = await readFile(file, 'utf8').catch(() => '')
    await writeFile(file, `${previous}${text}\n`, { mode: 0o600 }).catch(() => '')
  }
}

/** Aísla un sitio en una versión concreta; `null` lo devuelve a la global. */
export async function isolateSitePhp(name: string, version: string | null): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Error('Invalid site name')
  if (version !== null && !/^\d+\.\d+$/.test(version)) throw new Error('Invalid PHP version')
  await prepareHelpers()
  if (version === null) {
    const domain = await valetDomain()
    const certificate = join(VALET, 'Certificates', `${name}.${domain}.crt`)
    if (existsSync(certificate)) {
      await runValet(['unisolate', `--site=${name}`])
      return
    }
    // Valet Linux reescribe una configuración "secure" al desaislar aunque el
    // sitio no tenga certificado, y nginx se niega a arrancar. Sin certificado,
    // el estado correcto es no tener archivo propio: se elimina y se reinicia.
    const config = isolatedSiteConfig(name, domain)
    if (config) {
      await unlink(config)
      await runValet(['restart'])
    }
    return
  }
  await runValet(['isolate', version, `--site=${name}`])
}

/** Tamaño aproximado de los archivos de una versión, para la ficha. */
/** Añade a mano el repositorio PHP que corresponde a esta distro. */
export async function configurePhpRepository(log: (text: string) => void): Promise<void> {
  await addPhpRepository(log)
}

export async function phpVersionSize(version: string): Promise<number | null> {
  // dpkg conoce el tamaño instalado de todos los paquetes de la versión,
  // incluidas las extensiones que viven fuera de /etc/php.
  const dpkg = await run('dpkg-query', ['-W', '-f=${Package}\t${Installed-Size}\n', `php${version}-*`], true)
  let total = 0
  for (const line of dpkg.split('\n')) {
    const kb = Number(line.split('\t')[1])
    if (Number.isFinite(kb) && kb > 0) total += kb * 1024
  }
  if (total > 0) return total
  const dir = `/etc/php/${version}`
  if (!existsSync(dir)) return null
  const walk = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) await walk(full)
      else total += (await stat(full).catch(() => ({ size: 0 }))).size
    }
  }
  await walk(dir)
  return total || null
}

/** Extensiones que un proyecto declara en `composer.json`. */
export function requiredExtensions(composer: unknown): string[] {
  if (!composer || typeof composer !== 'object') return []
  const req = (composer as { require?: Record<string, unknown> }).require
  if (!req || typeof req !== 'object') return []
  return Object.keys(req)
    .filter((k) => k.startsWith('ext-'))
    .map((k) => k.slice(4).toLowerCase())
}

/** `php` del bloque `require` de composer.json (`^8.2`). */
export function composerPhpConstraint(composer: unknown): string | null {
  if (!composer || typeof composer !== 'object') return null
  const req = (composer as { require?: Record<string, unknown> }).require
  const php = req && typeof req === 'object' ? (req as Record<string, unknown>).php : null
  return typeof php === 'string' ? php : null
}
