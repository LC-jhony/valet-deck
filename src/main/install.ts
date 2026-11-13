import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { constants, existsSync } from 'node:fs'
import { access, mkdir, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import type { DnsMode, Env, InstallEvent, InstallOptions, InstallSummaryRow, PhpInfo, Prereq } from '../shared/types'
import { NODE_VERSION, PHP_VERSION, nvmNodeCommands } from '../shared/stack'
import { parseValetVersion } from '../shared/valet-version'
import { APP_DIR, COMPOSER_BIN, COMPOSER_HOME, PACKAGE_TIMEOUT_MS, TIMEOUT_MS, run, runWithEnv } from './exec'
import { BACKUP_SCRIPT, DNS_SCRIPT } from './root-scripts'
import {
  OLD_RELEASES_SCRIPT, detectPlatform, eolWarning, planPhp, sourcesUseMainArchive, type PlatformInfo
} from './platform'
import { phpRepoError, phpRepoState, ensureAptPhpRepository, type PhpRepoRunner } from './php-repo'
import { distroProvidesTargetPhp } from '../shared/php-repo'
import {
  ROOT_HELPER_DIR, USER_NAME, installRootHelper, prepareHelpers, privilegedEnv, runValet, unprivilegedEnv
} from './helpers'
import { detectElevation, elevated, elevationCommand } from './elevate'
import { classify, commandLabel } from './errors'
import {
  APT_ENV, APT_OPTS, PHP_OPTIONAL_EXTENSIONS, evaluate, hasBlocking, installArgs, mariadbPackages,
  mirrorHost, missingQuery, parseMissing, requiredPackages, updateArgs, type PhpExtension, type Pm,
  type PrereqProbe
} from './prereqs'
import { apacheInfo, listSites, phpInfo, phpUseArgs, scanPorts, valetDomain, valetHttpPort } from './valet'
import { installNvm, nvmAvailable, nvmDir, nvmEnv, nvmScript } from './nvm'
import { MARIADB_DATA_DIR, MARIADB_INSTALLED_MARKER, findMariaDbClient, foreignMariaDbReason, markMariaDbInstalled, prepareMariaDb, readMariaDbCredentials, testMariaDbCredentials } from './mariadb-setup'
import { phpPackagesFromDpkg } from './php-versions'

const HOME = homedir()
const PKG_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i
const DNS_MODES: DnsMode[] = ['safe', 'hosts']
const DNS_PORT = 5354
const DNS_HELPER = join(ROOT_HELPER_DIR, 'dns-helper.sh')
const BACKUP_HELPER = join(ROOT_HELPER_DIR, 'backup.sh')
const TOOL_NAMES = [
  'php', 'composer', 'valet', 'nginx', 'dnsmasq', 'nmcli', 'certutil',
  'xsel', 'pkexec', 'sudo', 'zenity', 'kdialog', 'jq', 'git', 'unzip'
]
let busy = false
let current: ChildProcess | null = null
let cancelRequested = false

export type Emit = (e: InstallEvent) => void
export type Step = { id: string; label: string; fn: () => Promise<'skip' | void> }

export async function distro(): Promise<{ id: string; pm: Pm | null; ubuntu: boolean; platform: PlatformInfo }> {
  const t = await readFile('/etc/os-release', 'utf8').catch(() => '')
  const platform = detectPlatform(t)
  const get = (k: string) => (t.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').replace(/"/g, '')
  const s = `${get('ID')} ${get('ID_LIKE')}`
  const pm: Pm | null = /debian|ubuntu/.test(s) ? 'apt' : /fedora|rhel|centos/.test(s) ? 'dnf' : /arch/.test(s) ? 'pacman' : null
  // El PPA de Ondrej vive en Launchpad: solo sirve en Ubuntu y derivadas, y
  // únicamente en las LTS con soporte (ver `planPhp`). Debian también es apt,
  // pero allí se usa el PHP de la distribución.
  return { id: platform.prettyName, pm, ubuntu: platform.ubuntu, platform }
}

/** Texto de los orígenes de apt (sources.list y sources.list.d). */
async function readAptSources(): Promise<string> {
  const files = ['/etc/apt/sources.list']
  const extra = await readdir('/etc/apt/sources.list.d').catch(() => [] as string[])
  for (const name of extra) if (/\.(list|sources)$/.test(name)) files.push(join('/etc/apt/sources.list.d', name))
  const parts = await Promise.all(files.map((f) => readFile(f, 'utf8').catch(() => '')))
  return parts.join('\n')
}

const has = async (c: string) => (await run('which', [c], true)).trim() !== ''
const active = async (service: string) => (await run('systemctl', ['is-active', service], true)).trim() === 'active'
/** La unidad existe solo si el paquete del servidor está instalado. */
const serviceExists = async (unit: string): Promise<boolean> =>
  (await run('systemctl', ['list-unit-files', '--no-legend', unit], true)).trim() !== ''

/** Servidor MariaDB presente, aunque su binario no esté en el PATH (Fedora). */
async function mariaDbServerInstalled(): Promise<boolean> {
  return await serviceExists('mariadb.service') || await has('mariadbd')
}

/** Servidor MySQL ajeno; se comprueba después de descartar MariaDB. */
async function mysqlServerInstalled(): Promise<boolean> {
  return await serviceExists('mysql.service') ||
    await serviceExists('mysqld.service') ||
    await has('mysqld')
}

async function phpVersion(): Promise<string | null> {
  const v = (await run('php', ['-r', 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;'], true)).trim()
  return /^\d+\.\d+$/.test(v) ? v : null
}

/** Versión del PHP-FPM que está sirviendo ahora mismo, si hay alguna. */
async function activePhpFpm(): Promise<string | null> {
  const units = (await run(
    'systemctl', ['list-unit-files', '--type=service', '--no-legend', '--no-pager', 'php*-fpm*.service'], true
  )).split('\n')
    .map((l) => l.trim().split(/\s+/)[0].replace(/\.service$/, ''))
    .filter((u) => /^php(\d+\.\d+)?-fpm$/.test(u))
  for (const unit of units) {
    if ((await run('systemctl', ['is-active', unit], true)).trim() !== 'active') continue
    const m = unit.match(/^php(\d+\.\d+)-fpm$/)
    if (m) return m[1]
    if (unit === 'php-fpm') return await phpVersion()
  }
  return null
}

/** ¿El repositorio configurado ofrece el paquete? `apt-cache` sale con 100 si no existe. */
async function aptPackageExists(name: string): Promise<boolean> {
  return (await run('apt-cache', ['show', name], true)).trim() !== ''
}

/** Extensiones opcionales que el repositorio no ofrece para esa versión. */
async function unavailablePhpExtensions(php: string): Promise<PhpExtension[]> {
  const found = await Promise.all(PHP_OPTIONAL_EXTENSIONS.map(async (ext): Promise<PhpExtension | null> =>
    (await aptPackageExists(`php${php}-${ext}`)) ? null : ext))
  return found.filter((ext): ext is PhpExtension => ext !== null)
}

const phpRepoRunner = (emit: Emit): PhpRepoRunner => ({
  elevated: (cmd, args) => shElevated(emit, cmd, args, { pm: 'apt', timeoutMs: PACKAGE_TIMEOUT_MS }),
  log: (text) => emit({ type: 'log', text })
})

async function diskFreeMb(): Promise<number> {
  const st = await statfs(HOME).catch(() => null)
  if (!st) return Number.POSITIVE_INFINITY
  return (st.bavail * st.bsize) / (1024 * 1024)
}

/** Comprueba que el repositorio se resuelve. `null` si no se puede saber. */
async function networkOk(pm: Pm | null): Promise<boolean | null> {
  if (!pm) return null
  const out = await run('getent', ['hosts', mirrorHost(pm)], true)
  return out.trim() !== ''
}

async function probeTools(): Promise<Record<string, boolean>> {
  const tools: Record<string, boolean> = {}
  await Promise.all(TOOL_NAMES.map(async (t) => { tools[t] = await has(t) }))
  return tools
}

function normalizePkg(p: string): string {
  if (typeof p !== 'string' || !PKG_RE.test(p)) throw new Error('Invalid Composer package (vendor/name)')
  return p.toLowerCase()
}

function normalizeDnsMode(mode: unknown): DnsMode {
  return typeof mode === 'string' && DNS_MODES.includes(mode as DnsMode) ? mode as DnsMode : 'safe'
}

async function prepareInstallScripts() {
  await installRootHelper('dns-helper.sh', DNS_SCRIPT)
  await installRootHelper('backup.sh', BACKUP_SCRIPT)
}

type ShOptions = {
  cwd?: string
  extraEnv?: NodeJS.ProcessEnv
  env?: NodeJS.ProcessEnv
  pm?: Pm | null
  /** Límite propio; los paquetes usan {@link PACKAGE_TIMEOUT_MS}. */
  timeoutMs?: number
}

/**
 * Composer ejecuta scripts y plugins de paquetes de terceros: su entorno no
 * incluye el ayudante `sudo` ni `SUDO_ASKPASS` que sí usa Valet.
 */
export const composerEnv = (): NodeJS.ProcessEnv =>
  unprivilegedEnv({ COMPOSER_HOME, COMPOSER_NO_INTERACTION: '1' })

/**
 * Termina el proceso y, si sigue vivo cinco segundos después, lo fuerza. Al
 * cancelar apt hay que asegurarse de que dpkg no quede con el bloqueo tomado.
 */
function terminate(c: ChildProcess): NodeJS.Timeout {
  c.kill('SIGTERM')
  return setTimeout(() => {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  }, 5_000)
}

/** «45s» o «2m 05s» para el aviso de progreso. */
const elapsed = (ms: number): string => {
  const secs = Math.floor(ms / 1000)
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`
}

/** Ejecuta un paso cualquiera y, si falla, emite el diagnóstico clasificado. */
export function sh(emit: Emit, cmd: string, args: string[], opts: ShOptions = {}): Promise<void> {
  emit({ type: 'log', text: `$ ${cmd} ${args.join(' ')}\n` })
  const limitMs = opts.timeoutMs ?? TIMEOUT_MS
  const label = commandLabel(cmd, args)
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const c = spawn(cmd, args, { env: opts.env ?? privilegedEnv(opts.extraEnv), cwd: opts.cwd })
    current = c
    // Valet escribe sus errores en stdout (Symfony Console), no en stderr: se
    // guardan ambos para que `classify` pueda reconocerlos.
    let output = ''
    let timedOut = false
    let force: NodeJS.Timeout | null = null
    const timer = setTimeout(() => { timedOut = true; force = terminate(c) }, limitMs)
    // Un paso largo sin salida parece colgado: cada 30 s se deja constancia de
    // que sigue vivo (apt solo imprime algo al empezar cada descarga).
    const beat = setInterval(() => {
      emit({ type: 'log', text: `… ${label} is still running (${elapsed(Date.now() - started)}).\n` })
    }, 30_000)
    const finish = () => {
      clearTimeout(timer)
      clearInterval(beat)
      if (force) clearTimeout(force)
    }
    const out = (b: Buffer) => {
      output += b.toString()
      emit({ type: 'log', text: b.toString() })
    }
    c.stdout?.on('data', out)
    c.stderr?.on('data', out)
    c.on('error', (e) => { finish(); current = null; reject(e) })
    c.on('close', (code) => {
      finish()
      current = null
      if (cancelRequested) {
        cancelRequested = false
        return reject(new Error('Operation cancelled'))
      }
      if (code === 0) return resolve()
      const error = classify({
        cmd, args, code, stderr: output, killed: timedOut, pm: opts.pm ?? null, timeoutMs: limitMs
      })
      emit({ type: 'error', ...error })
      reject(new Error(error.title))
    })
  })
}

/** Igual que {@link sh}, con la elevación que haya disponible. */
export async function shElevated(emit: Emit, cmd: string, args: string[], opts: ShOptions = {}): Promise<void> {
  const how = await elevationCommand()
  if (!how) throw new Error('No elevation method: install polkit (pkexec) or sudo with zenity')
  return sh(emit, how.cmd, [...how.args, cmd, ...args], opts)
}

export async function runSteps(steps: Step[], emit: Emit) {
  if (busy) throw new Error('An operation is already running')
  busy = true
  cancelRequested = false
  try {
    emit({ type: 'plan', steps: steps.map(({ id, label }) => ({ id, label })) })
    for (const s of steps) {
      if (cancelRequested) throw new Error('Operation cancelled')
      emit({ type: 'step', id: s.id, status: 'run' })
      try {
        emit({ type: 'step', id: s.id, status: (await s.fn()) === 'skip' ? 'skip' : 'ok' })
      } catch (e) {
        emit({ type: 'step', id: s.id, status: 'fail' })
        emit({ type: 'log', text: `\n✖ ${(e as Error).message}\n` })
        throw e
      }
    }
  } finally {
    busy = false
    cancelRequested = false
  }
}

/** Detiene el comando en curso. La interfaz vuelve a quedar utilizable. */
export function cancelInstall(): void {
  if (!busy) return
  cancelRequested = true
  if (current) terminate(current)
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function backupSystem(emit: Emit): Promise<string> {
  const dest = join(APP_DIR, 'backups', stamp(), 'system')
  if (!dest.startsWith(APP_DIR + sep)) throw new Error('Invalid backup path')
  await mkdir(APP_DIR, { recursive: true })
  await elevated(BACKUP_HELPER, [dest, USER_NAME])
  emit({ type: 'log', text: `Backup: ${dest}\n` })
  return dest
}

async function writeHostsFile(emit: Emit): Promise<string> {
  const domain = await valetDomain().catch(() => 'test')
  const names = new Set<string>(['valet-studio'])
  for (const s of await listSites().catch(() => [])) {
    if (/^[a-z0-9.-]+$/i.test(s.name)) names.add(s.name)
  }
  const body = [...names].sort().map((n) => `127.0.0.1 ${n}.${domain}`).join('\n') + '\n'
  const file = join(APP_DIR, 'hosts-generated')
  await mkdir(APP_DIR, { recursive: true })
  await writeFile(file, body, { mode: 0o600 })
  emit({ type: 'log', text: `Host entries prepared: ${names.size}\n` })
  return file
}

export async function patchValetDns(pkg: string, emit: Emit) {
  const [vendor, name] = pkg.split('/')
  const file = join(COMPOSER_HOME, 'vendor', vendor, name, 'cli', 'Valet', 'DnsMasq.php')
  if (!existsSync(file)) throw new Error(`${file} was not found. Composer did not install the expected package.`)
  let src = await readFile(file, 'utf8')
  const original = src
  if ((src.match(/VALET_STUDIO_SAFE_DNS/g) ?? []).length >= 2) {
    emit({ type: 'log', text: 'Safe DNS patch already applied.\n' })
    return
  }
  const guard = `
        if (getenv('VALET_STUDIO_SAFE_DNS') === '1') {
            info('Valet Deck: Valet DNS changes skipped.');
            return;
        }
`
  src = src.replace(/(public function install\([^)]*\)\s*\{\r?\n)/, (_m, pre: string) => `${pre}${guard}`)
  src = src.replace(/(public function uninstall\(\)\s*\{\r?\n)/, (_m, pre: string) => `${pre}${guard}`)
  if ((src.match(/VALET_STUDIO_SAFE_DNS/g) ?? []).length < 2) {
    throw new Error('Could not apply the safe DNS patch; cancelling before touching the network.')
  }
  await writeFile(file, src)
  try {
    await run('php', ['-l', file])
  } catch (e) {
    await writeFile(file, original)
    throw new Error(`The DNS patch left PHP invalid; the file was restored: ${(e as Error).message}`)
  }
  emit({ type: 'log', text: `Safe DNS patch applied to ${file}\n` })
}

async function applyDns(emit: Emit, mode: DnsMode): Promise<'skip' | void> {
  const domain = await valetDomain().catch(() => 'test')
  const backupDir = join(APP_DIR, 'backups', stamp(), 'dns')
  const hostsFile = mode === 'hosts' ? await writeHostsFile(emit) : ''
  await elevated(DNS_HELPER, [mode, domain, backupDir, hostsFile, USER_NAME])
  const name = `valet-studio.${domain}`
  const resolved = (await run('getent', ['hosts', name], true)).trim()
  if (!resolved.includes('127.0.0.1')) {
    throw new Error(`Could not verify ${name}; check systemd-resolved or use hosts mode.`)
  }
  emit({ type: 'log', text: `DNS verified: ${name} -> 127.0.0.1\n` })
}

/** Retira los restos del DNS clásico de Valet y devuelve la red a systemd-resolved. */
async function cleanupClassicDns(emit: Emit) {
  const domain = await valetDomain().catch(() => 'test')
  const backupDir = join(APP_DIR, 'backups', stamp(), 'dns-classic')
  emit({ type: 'log', text: 'Removing leftovers from the classic Valet DNS…\n' })
  const out = await elevated(DNS_HELPER, ['cleanup-classic', domain, backupDir, '', USER_NAME])
  if (out.trim()) emit({ type: 'log', text: `${out.trim()}\n` })
}

async function removeDns(emit: Emit) {
  const domain = await valetDomain().catch(() => 'test')
  const backupDir = join(APP_DIR, 'backups', stamp(), 'dns-remove')
  await elevated(DNS_HELPER, ['remove', domain, backupDir, '', USER_NAME])
  emit({ type: 'log', text: 'Valet Deck DNS removed.\n' })
}

async function requireElevation() {
  if (!(await detectElevation())) {
    throw new Error('An elevation method is missing: install polkit (pkexec) or sudo with zenity')
  }
}

/** Paquetes de la lista que aún no están instalados. */
async function missingPackages(pm: Pm, packages: string[]): Promise<string[]> {
  const q = missingQuery(pm, packages)
  const out = await run(q.cmd, q.args, true)
  return parseMissing(pm, packages, out)
}

export async function checkEnv(): Promise<Env> {
  const d = await distro()
  const [tools, systemd, disk, network, elevation] = await Promise.all([
    probeTools(),
    Promise.resolve(existsSync('/run/systemd/system')),
    diskFreeMb(),
    networkOk(d.pm),
    detectElevation()
  ])
  const probe: PrereqProbe = {
    pm: d.pm,
    systemd,
    graphical: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    diskFreeMb: disk,
    network,
    tools
  }
  const prereqs: Prereq[] = evaluate(probe)

  const [ports, nm, resolved, dnsmasqService, dashboardService, valetDnsService, udp, resolvTarget, resolvContent, show, domain, isolatedValet, nodeOut, mariadbInstalled, mariadbActive] = await Promise.all([
    scanPorts(),
    active('NetworkManager'),
    active('systemd-resolved'),
    active('dnsmasq'),
    active('valet-studio-dns'),
    active('valet-dns'),
    run('ss', ['-lun'], true),
    run('readlink', ['-f', '/etc/resolv.conf'], true),
    readFile('/etc/resolv.conf', 'utf8').catch(() => ''),
    run('composer', ['global', 'show'], true),
    valetDomain().catch(() => 'test'),
    Promise.resolve(join(COMPOSER_BIN, 'valet')),
    run('node', ['-v'], true),
    mariaDbServerInstalled(),
    active('mariadb')
  ])

  const nodeVersion = nodeOut.trim().replace(/^v/, '')

  // `ss -p` no muestra el proceso de nginx o Apache cuando corren como root.
  // Se cruza el puerto con su configuración para no confundirlos con un intruso.
  const apachePorts = new Set([ports.apache.http, ports.apache.https].filter((p): p is number => p !== null))
  const ownerOf = (port: number, process: string): string => {
    if (process !== '—') return process
    if (ports.nginxActive && (port === ports.config.http || port === ports.config.https)) return 'nginx'
    if (ports.apache.active && apachePorts.has(port)) return 'apache2'
    return 'another process'
  }
  const portHogs = ports.usage
    .filter((u) => [80, 443].includes(u.port))
    .map((u) => `${u.port}: ${ownerOf(u.port, u.process)}`)
    .filter((line) => !line.endsWith(': nginx'))

  const isolated = existsSync(isolatedValet)
  const resolvConfOk = /stub-resolv/.test(resolvTarget) || resolvContent.includes('127.0.0.53')
  const classicResolv = !resolvConfOk && /^\s*nameserver\s+127\.0\.0\.1(?:\s|$)/m.test(resolvContent)
  const classicLeftovers = Boolean(
    valetDnsService ||
    existsSync('/opt/valet-linux') ||
    existsSync('/etc/dnsmasq.d/valet') ||
    existsSync('/etc/NetworkManager/conf.d/valet.conf') ||
    classicResolv
  )
  const systemValet = (await run('which', ['valet'], true)).trim()
  const valetPath = isolated ? isolatedValet : (systemValet || null)
  const valetVersion = parseValetVersion(valetPath ? await run(valetPath, ['--version'], true) : '') || null
  tools.valet = Boolean(valetPath)

  const dnsPortInUse = ports.usage.some((u) => u.port === DNS_PORT) || new RegExp(`:${DNS_PORT}(?:\\s|$)`).test(udp)
  const portFree = dashboardService || !dnsPortInUse
  const testResolves = (await run('getent', ['hosts', `valet-studio.${domain}`], true)).includes('127.0.0.1')

  const oldValet = /cpriego\/valet-ubuntu|jmarcher\/valet-linux/.test(show)
  const illuminate13 = /^illuminate\/[^\s]+\s+13\./m.test(show)
  const conflictDetail = oldValet
    ? 'There are old Valet packages in the global Composer.'
    : illuminate13
      ? 'Illuminate 13 in the global Composer; Valet requires Illuminate <=12.'
      : ''

  const warnings: string[] = []
  if (portHogs.length) warnings.push(`Ports 80/443 in use: ${portHogs.join(', ')}.`)
  if (conflictDetail) warnings.push(`${conflictDetail} An isolated Composer will be used.`)
  if (valetPath && !isolated) warnings.push(`External Valet detected at ${valetPath}; the installer prefers its own isolated Composer.`)
  if (!resolved) warnings.push('systemd-resolved is not running; safe DNS mode is not available.')
  if (!portFree) warnings.push(`Port ${DNS_PORT} is in use; hosts mode is recommended.`)
  if (dnsmasqService) warnings.push(`The system dnsmasq service is active; safe DNS uses its own instance on ${DNS_PORT}.`)
  if (classicLeftovers) {
    warnings.push('Leftovers from the classic Valet DNS were found; the installer removes them and restores systemd-resolved before applying Dynamic DNS.')
  }
  if (!resolvConfOk && !classicLeftovers) warnings.push('/etc/resolv.conf does not point to systemd-resolved; check DNS before using Dynamic mode.')
  const eol = eolWarning(d.platform)
  if (eol) warnings.push(eol)
  const phpNote = planPhp(d.platform, PHP_VERSION).note
  if (phpNote) warnings.push(phpNote)
  if (!d.pm) warnings.push('Distribution not supported for automatic package installation; the panel will continue with what is already installed.')

  const php = await phpInfo().catch(() => null)
  const phpEnv: PhpInfo = php ?? { target: null, current: '', managed: '', installed: false, fpmActive: false }
  if (phpEnv.target && phpEnv.current && phpEnv.current !== phpEnv.target) {
    warnings.push(`PHP ${phpEnv.current} is in use, but Valet Deck manages PHP ${phpEnv.target}. Run "Repair everything" to switch to ${phpEnv.target}.`)
  }

  const recommendedDnsMode: DnsMode =
    (resolved || (classicLeftovers && existsSync('/run/systemd/resolve/stub-resolv.conf'))) &&
    portFree && (resolvConfOk || classicLeftovers) && (tools.dnsmasq || d.pm === 'apt')
      ? 'safe'
      : 'hosts'

  return {
    distro: d.id,
    pm: d.pm,
    tools,
    portHogs,
    dns: {
      domain,
      networkManager: nm,
      resolvedActive: resolved,
      dnsmasqBinary: tools.dnsmasq,
      dnsmasqServiceActive: dnsmasqService,
      dashboardActive: dashboardService,
      port: DNS_PORT,
      portFree,
      resolvConfOk,
      testResolves,
      classicLeftovers
    },
    composer: {
      available: tools.composer,
      globalHome: join(HOME, '.config', 'composer'),
      isolatedHome: COMPOSER_HOME,
      isolatedValet: isolated,
      conflict: Boolean(conflictDetail),
      conflictDetail
    },
    valet: {
      installed: Boolean(valetPath),
      path: valetPath,
      version: valetVersion,
      isolated
    },
    php: phpEnv,
    node: {
      installed: nodeVersion !== '',
      version: nodeVersion,
      nvm: nvmAvailable()
    },
    mariadb: {
      installed: mariadbInstalled,
      active: mariadbActive
    },
    prereqs,
    elevation,
    warnings,
    recommendedDnsMode
  }
}

function resolveParkDir(input: string): string {
  const value = (typeof input === 'string' ? input : '').trim()
  const out = value === ''
    ? join(HOME, 'Sites')
    : value === '~'
      ? HOME
      : value.startsWith('~/')
        ? join(HOME, value.slice(2))
        : value
  if (!isAbsolute(out)) throw new Error('The projects folder must be an absolute path')
  return out
}

/** Directorios del sistema que nunca deben convertirse en raíz de proyectos. */
const SYSTEM_DIRS = new Set([
  '/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/opt',
  '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var'
])

/** Ramas completas del sistema: tampoco vale una carpeta dentro de ellas. */
const SYSTEM_TREES = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr']

/**
 * Motivo por el que una carpeta no sirve como raíz de proyectos, o `null` si
 * vale. Es puro: no toca el disco, para poder probarlo sin sistema de archivos.
 * `/var/www` y `/opt/...` sí se permiten; lo que se bloquea es convertir una
 * rama del sistema en raíz de sitios.
 */
export function parkDirProblem(dir: string): string | null {
  const real = resolve(dir)
  if (SYSTEM_DIRS.has(real) || SYSTEM_TREES.some((tree) => real.startsWith(`${tree}/`))) {
    return `${real} is a system directory; choose a projects folder such as ~/Sites.`
  }
  return null
}

/** Primer ancestro que impide crear la carpeta, o `null` si se puede escribir. */
async function parkDirUnwritable(dir: string): Promise<string | null> {
  let probe = resolve(dir)
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  try {
    await access(probe, constants.W_OK | constants.X_OK)
    return null
  } catch {
    return probe
  }
}

/**
 * Crea un sitio temporal y pide su `index.php` por HTTP. Es la única prueba que
 * responde de verdad «¿funciona Valet?»: cubre nginx, PHP-FPM y permisos.
 * Devuelve también el motivo cuando se salta, para no inventar uno en el resumen.
 */
async function smokeTest(parkDir: string, emit: Emit): Promise<{ state: 'ok' | 'skip'; detail: string }> {
  const dir = join(parkDir, 'valet-studio-health')
  if (!dir.startsWith(parkDir + sep)) throw new Error('Invalid test path')
  if (existsSync(dir)) {
    emit({ type: 'log', text: `${dir} already exists; skipping the smoke test.\n` })
    return { state: 'skip', detail: `${dir} already exists; the smoke test was skipped.` }
  }
  if (!(await has('curl'))) {
    emit({ type: 'log', text: 'curl is missing: skipping the smoke test.\n' })
    return { state: 'skip', detail: 'curl is not installed; the smoke test was skipped.' }
  }
  const domain = await valetDomain().catch(() => 'test')
  const port = await valetHttpPort()
  const body = join(APP_DIR, 'smoke-body')
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.php'), "<?php echo 'valet-ok';\n")
    const status = (await run('curl', [
      '-sS', '-m', '10', '-o', body, '-w', '%{http_code}',
      '-H', `Host: valet-studio-health.${domain}`,
      `http://127.0.0.1:${port}/index.php`
    ], true)).trim()
    const text = await readFile(body, 'utf8').catch(() => '')
    if (status === '200' && text.includes('valet-ok')) {
      emit({ type: 'log', text: `Smoke test passed: nginx and PHP-FPM respond on port ${port}.\n` })
      return { state: 'ok', detail: `nginx and PHP-FPM answered valet-ok on port ${port}.` }
    }
    if (status === '502') {
      throw new Error('PHP-FPM is not responding: check the ~/.valet socket and the php-fpm service')
    }
    if (status === '404') {
      throw new Error('nginx cannot find the test site: check the Valet configuration')
    }
    if (!status || status === '000' || status === '7') {
      throw new Error(`nginx is not responding on port ${port}: check systemctl status nginx`)
    }
    throw new Error(`The smoke test returned HTTP ${status}`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => '')
    await rm(body, { force: true }).catch(() => '')
  }
}

/**
 * Comprobaciones finales que se muestran como una lista verde/roja. Una
 * comprobación que revienta (por ejemplo, porque falta el binario) no oculta
 * las demás: se apunta como fallo y el paso de resumen decide al final.
 */
async function collectSummary(
  phpTarget: string | null,
  withMariaDb: boolean,
  withNode: boolean,
  smoke: { state: 'ok' | 'skip'; detail: string },
  skipDns: boolean
): Promise<InstallSummaryRow[]> {
  const rows: InstallSummaryRow[] = []
  const add = async (id: string, label: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      const result = await fn()
      rows.push({ id, label, state: result.ok ? 'ok' : 'fail', detail: result.detail })
    } catch (e) {
      rows.push({ id, label, state: 'fail', detail: (e as Error).message })
    }
  }

  const domain = await valetDomain().catch(() => 'test')
  await add('valet', 'Valet', async () => {
    const out = (await runValet(['--version'], true)).trim()
    return { ok: Boolean(out), detail: out.split('\n')[0] || 'valet did not answer' }
  })
  await add('binary', '/usr/local/bin/valet', async () => {
    const ok = existsSync('/usr/local/bin/valet')
    return { ok, detail: ok ? 'present' : 'missing' }
  })
  await add('composer', 'Isolated Composer', async () => {
    const ok = existsSync(join(COMPOSER_BIN, 'valet'))
    return { ok, detail: ok ? COMPOSER_BIN : 'the isolated Valet binary is missing' }
  })
  await add('nginx', 'nginx', async () => {
    const ok = await active('nginx')
    return { ok, detail: ok ? 'running' : 'not running' }
  })
  if (phpTarget) {
    await add('php', `PHP ${phpTarget}-FPM`, async () => {
      const fpm = await active(`php${phpTarget}-fpm`)
      const version = await phpVersion()
      return {
        ok: fpm && version === phpTarget,
        detail: fpm ? `php reports ${version || 'nothing'}` : 'not running'
      }
    })
  } else {
    // Sin versión fijada el PHP es el único de la distribución: se comprueba su
    // PHP-FPM.
    await add('php', 'PHP-FPM', async () => {
      const info = await phpInfo().catch(() => null)
      return {
        ok: Boolean(info?.fpmActive),
        detail: info?.fpmActive ? `php${info.managed}-fpm active` : 'no php-fpm service is active'
      }
    })
  }
  if (skipDns) {
    rows.push({ id: 'dns', label: 'DNS', state: 'skip', detail: 'Left untouched by this setup.' })
  } else {
    await add('dns', `DNS for *.${domain}`, async () => {
      const out = await run('getent', ['hosts', `valet-studio.${domain}`], true)
      const ok = out.includes('127.0.0.1')
      return { ok, detail: ok ? `valet-studio.${domain} -> 127.0.0.1` : `valet-studio.${domain} does not resolve` }
    })
  }
  if (withMariaDb) {
    await add('mariadb', 'MariaDB', async () => {
      const running = await active('mariadb')
      if (!running) return { ok: false, detail: 'not running' }
      const credentials = await readMariaDbCredentials()
      if (!credentials) return { ok: false, detail: 'running, but the managed valet_studio user is missing' }
      const connected = await testMariaDbCredentials(credentials)
      return {
        ok: connected,
        detail: connected
          ? `running; ${credentials.username}@${credentials.host}:${credentials.port} connects`
          : 'running, but the managed valet_studio user cannot connect'
      }
    })
  }
  if (withNode) {
    await add('node', `Node.js ${NODE_VERSION}`, async () => {
      const out = (await runWithEnv(
        'bash', ['-c', `. "$NVM_SH" && nvm version ${NODE_VERSION}`], nvmEnv(), true
      )).trim()
      const ok = out.startsWith(`v${NODE_VERSION}.`)
      return { ok, detail: ok ? out : out || 'nvm did not report a version' }
    })
  }
  rows.push({ id: 'smoke', label: 'HTTP smoke test', state: smoke.state, detail: smoke.detail })
  return rows
}

export async function startInstall(o: InstallOptions, emit: Emit) {
  if (!o || typeof o !== 'object') throw new Error('Invalid installation options')
  const withMariaDb = o.mariadb === true
  const withNode = o.node === true
  const pkg = normalizePkg(o.pkg)
  const dnsMode = normalizeDnsMode(o.dnsMode)
  const skipDns = o.skipDns === true
  const parkDir = resolveParkDir(o.parkDir)
  const d = await distro()
  // El panel fija PHP 8.5 solo en las Ubuntu que cubre el PPA de Ondrej;
  // Debian, las Ubuntu sin soporte y el resto de gestores usan el PHP único
  // de la distribución.
  const phpPlan = planPhp(d.platform, PHP_VERSION)
  const phpTarget = phpPlan.version
  await prepareHelpers()

  const S = (id: string, label: string, fn: Step['fn']): Step => ({ id, label, fn })
  let preflight: Env | undefined
  let smoke: { state: 'ok' | 'skip'; detail: string } = {
    state: 'skip',
    detail: 'The HTTP smoke test did not run.'
  }

  await runSteps([
    S('preflight', skipDns ? 'Check requirements and ports' : 'Check requirements, ports and DNS', async () => {
      const info = await checkEnv()
      preflight = info
      const blocking = info.prereqs.filter((p) => !p.ok && p.blocking)
      if (hasBlocking(info.prereqs)) {
        throw new Error(`Missing requirements: ${blocking.map((p) => p.label).join(', ')}. Follow the guide in the Installation tab.`)
      }
      if (info.portHogs.length && !(o.stopApache && info.portHogs.every((h) => /apache/i.test(h)))) {
        throw new Error(`Free ports 80/443 before installing: ${info.portHogs.join(', ')}`)
      }
      if (!skipDns && dnsMode === 'safe') {
        const canRestoreResolved = info.dns.classicLeftovers && existsSync('/run/systemd/resolve/stub-resolv.conf')
        if (!info.dns.resolvedActive && !canRestoreResolved) {
          throw new Error('systemd-resolved is not running; choose hosts mode or start it first.')
        }
        if (!info.dns.portFree) throw new Error(`Port ${DNS_PORT} is in use; choose hosts mode.`)
        if (!info.dns.dnsmasqBinary && info.pm !== 'apt') throw new Error('dnsmasq is missing; install it or use hosts mode.')
        if (!info.dns.resolvConfOk && !info.dns.classicLeftovers) {
          throw new Error('/etc/resolv.conf does not point to systemd-resolved; choose hosts mode.')
        }
      }
      if (!info.elevation) throw new Error('An elevation method is missing: install polkit (pkexec) or sudo with zenity')
      const parkProblem = parkDirProblem(parkDir)
      if (parkProblem) throw new Error(parkProblem)
      const unwritable = await parkDirUnwritable(parkDir)
      if (unwritable) {
        throw new Error(`The projects folder ${parkDir} is not writable (${unwritable}). Choose another folder or fix its permissions.`)
      }
      if (resolve(parkDir) === HOME) {
        emit({
          type: 'log',
          text: 'The projects folder is your home directory; every file there could be served by nginx. Consider ~/Sites.\n'
        })
      }
      if (withMariaDb && !info.pm) throw new Error('MariaDB needs apt, dnf or pacman.')
      if (withNode) {
        const network = info.prereqs.find((p) => p.id === 'network')
        if (network && !network.ok && !info.dns.classicLeftovers) {
          throw new Error('Node.js needs network access to download nvm and Node. Connect and refresh the diagnosis.')
        }
        if (!info.node.nvm && !info.tools.git && !info.pm) {
          throw new Error('Node.js needs nvm: install git or a compatible package manager, or install nvm by hand.')
        }
      }
      emit({ type: 'log', text: `Elevation: ${info.elevation === 'pkexec' ? 'polkit (pkexec)' : 'sudo with password prompt'}\n` })
    }),
    S('backup', 'Create a backup', async () => {
      await prepareInstallScripts()
      await backupSystem(emit)
    }),
    S('dns-cleanup', 'Remove leftover classic Valet DNS', async () => {
      if (skipDns || !preflight?.dns.classicLeftovers) return 'skip'
      await cleanupClassicDns(emit)
    }),
    S('apache', 'Free ports 80/443 (Apache)', async () => {
      if (!o.stopApache) return 'skip'
      const apache = await apacheInfo()
      const apacheHog = preflight?.portHogs.some((h) => /apache/i.test(h)) ?? false
      if (!apache.active || (!apacheHog && ![apache.http, apache.https].some((p) => p === 80 || p === 443))) return 'skip'
      await shElevated(emit, 'systemctl', ['disable', '--now', 'apache2'])
    }),
    S('apt-sources', 'Use the archived Ubuntu repositories', async () => {
      // Una versión sin soporte desaparece de archive.ubuntu.com: sin este
      // paso, `apt-get update` falla y no se puede instalar nada.
      if (d.pm !== 'apt' || d.platform.support !== 'eol') return 'skip'
      if (!sourcesUseMainArchive(await readAptSources())) return 'skip'
      const warning = eolWarning(d.platform)
      if (warning) emit({ type: 'log', text: `${warning}\n` })
      if (phpPlan.note) emit({ type: 'log', text: `${phpPlan.note}\n` })
      emit({ type: 'log', text: 'Pointing apt at old-releases.ubuntu.com (the originals are saved first).\n' })
      const helper = await installRootHelper('old-releases.sh', OLD_RELEASES_SCRIPT)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await shElevated(emit, helper, [join('/var/backups/valet-studio', `apt-${stamp}`)])
    }),
    S('php-repo', phpTarget ? `Prepare the PHP ${PHP_VERSION} repository` : 'Check the PHP repository', async () => {
      if (d.pm !== 'apt' || !d.platform.ubuntu) return 'skip'
      // Sin versión fija (26.04+, donde manda el PHP de la distribución) solo
      // hay algo que hacer si quedó un Sury de una versión anterior: se retira
      // antes de que apt intente resolver PHP con sus dependencias rotas.
      if (!phpTarget && !distroProvidesTargetPhp(d.platform)) return 'skip'
      return ensureAptPhpRepository(phpTarget ?? PHP_VERSION, phpRepoRunner(emit))
    }),
    S('deps', 'Install system dependencies', async () => {
      const selected = phpTarget ?? await phpVersion()
      const pm = d.pm
      if (!pm) {
        emit({ type: 'log', text: 'No compatible package manager: using the packages already installed.\n' })
        return 'skip'
      }
      const extra = withMariaDb ? mariadbPackages(pm) : []
      // `mariadb-server` reemplaza a `mysql-server` en Debian/Ubuntu y
      // `mariadb` entra en conflicto con `mysql` en Arch: no se pisa una
      // instalación ajena sin que la persona lo decida.
      let panelInstallsMariaDb = false
      if (withMariaDb && !(await mariaDbServerInstalled())) {
        const conflict = foreignMariaDbReason({
          mariadbServer: false,
          mysqlServer: await mysqlServerInstalled(),
          dataDirInitialized: existsSync(join(MARIADB_DATA_DIR, 'mysql'))
        })
        if (conflict) throw new Error(conflict)
        panelInstallsMariaDb = true
      }
      let packages = requiredPackages(pm, selected, [], extra)
      let missing = await missingPackages(pm, packages)
      if (!missing.length) {
        emit({ type: 'log', text: 'System dependencies already installed.\n' })
        return 'skip'
      }
      emit({ type: 'log', text: `Missing ${missing.length} packages: ${missing.join(', ')}\n` })
      const update = updateArgs(pm)
      if (update) await shElevated(emit, update.cmd, update.args, { pm, timeoutMs: PACKAGE_TIMEOUT_MS })
      if (pm === 'apt' && selected) {
        if (!(await aptPackageExists(`php${selected}-cli`))) {
          throw new Error(phpRepoError(selected, await phpRepoState()))
        }
        const omitted = await unavailablePhpExtensions(selected)
        if (omitted.length) {
          emit({
            type: 'log',
            text: `PHP ${selected} has no ${omitted.join(', ')} in this repository; those extensions are skipped.\n`
          })
          packages = requiredPackages(pm, selected, omitted, extra)
          missing = await missingPackages(pm, packages)
        }
      }
      if (!missing.length) {
        emit({ type: 'log', text: 'System dependencies already installed.\n' })
        return 'skip'
      }
      const install = installArgs(pm, missing)
      await shElevated(emit, install.cmd, install.args, { pm, timeoutMs: PACKAGE_TIMEOUT_MS })
      if (panelInstallsMariaDb && await mariaDbServerInstalled()) {
        try {
          await markMariaDbInstalled()
        } catch (e) {
          emit({
            type: 'log',
            text: `Could not record that the panel installed MariaDB; uninstalling will leave it in place: ${(e as Error).message}\n`
          })
        }
      }
      if (!skipDns && dnsMode === 'safe' && !existsSync('/usr/sbin/dnsmasq')) {
        throw new Error('dnsmasq-base was not installed; choose hosts mode or install it by hand.')
      }
      const after = await scanPorts().catch(() => null)
      const bound = after?.usage.filter((u) => [80, 443].includes(u.port)) ?? []
      if (bound.length) {
        emit({ type: 'log', text: `Ports in use after installing: ${bound.map((u) => `${u.port} (${u.process})`).join(', ')}\n` })
      }
    }),
    S('composer', 'Install Valet with an isolated Composer', async () => {
      if (existsSync(join(COMPOSER_BIN, 'valet'))) {
        emit({ type: 'log', text: 'Valet is already in the isolated Composer.\n' })
        return 'skip'
      }
      await sh(emit, 'composer', ['global', 'require', pkg, '--no-interaction', '--no-progress'], {
        env: composerEnv()
      })
      if (!existsSync(join(COMPOSER_BIN, 'valet'))) throw new Error('Composer did not create the valet binary in the isolated home.')
    }),
    S('patch', 'Apply DNS protection to Valet', async () => {
      await patchValetDns(pkg, emit)
    }),
    S('install', 'Configure nginx and PHP-FPM', async () => {
      await sh(emit, 'valet', ['install'], {
        extraEnv: { VALET_STUDIO_SAFE_DNS: '1' }
      })
      try {
        await shElevated(emit, 'nginx', ['-t'])
      } catch (e) {
        throw new Error(`The nginx configuration is not valid: ${(e as Error).message}`)
      }
    }),
    S('php', 'Use the managed PHP version', async () => {
      if (!phpTarget) return 'skip'
      const bin = `/usr/bin/php${phpTarget}`
      if (!existsSync(bin)) throw new Error(`php${phpTarget} is not installed: php${phpTarget}-cli is missing.`)
      // Valet 2.4.5 detiene y deshabilita el FPM anterior antes de intentar el
      // cambio; si falla, lo vuelve a habilitar pero no lo arranca. Se guarda
      // el FPM que estaba sirviendo, no lo que reporta el `php` de la CLI.
      const previous = await activePhpFpm()
      try {
        await sh(emit, 'valet', phpUseArgs(phpTarget))
      } catch (e) {
        if (previous && previous !== phpTarget) {
          emit({ type: 'log', text: `PHP ${phpTarget} could not be activated; restoring PHP ${previous}...\n` })
          await shElevated(emit, 'systemctl', ['start', `php${previous}-fpm`]).catch(() => '')
          await runValet(phpUseArgs(previous)).catch(() => '')
          emit({ type: 'log', text: `PHP ${previous} is active again.\n` })
        }
        throw e
      }
      if ((await phpVersion()) !== phpTarget) {
        await shElevated(emit, 'update-alternatives', ['--set', 'php', bin])
      }
      emit({ type: 'log', text: `PHP ${phpTarget} is now the default.\n` })
    }),
    S('park', 'Register the projects folder', async () => {
      await mkdir(parkDir, { recursive: true })
      await sh(emit, 'valet', ['park'], { cwd: parkDir })
    }),
    S('dns', 'Configure the DNS for the sites', async () => {
      if (skipDns) {
        emit({ type: 'log', text: 'DNS left untouched by this setup.\n' })
        return 'skip'
      }
      await applyDns(emit, dnsMode)
    }),
    S('verify', 'Verify the installation', async () => {
      const version = (await runValet(['--version'], true)).trim()
      if (!version) throw new Error('Could not run Valet after the installation.')
      if (!existsSync('/usr/local/bin/valet')) throw new Error('Valet did not create /usr/local/bin/valet; check the /usr/local/bin permissions.')
      if (!(await active('nginx'))) throw new Error('nginx is not active. Check whether another service holds ports 80/443.')
      const php = await phpInfo().catch(() => null)
      if (phpTarget) {
        if (!php?.fpmActive) {
          throw new Error(`php${phpTarget}-fpm is not active; check it with systemctl.`)
        }
        if (php.current !== phpTarget) {
          throw new Error(`PHP ${phpTarget} is installed, but php still reports ${php.current || 'nothing'}.`)
        }
      } else if (!php?.fpmActive) {
        throw new Error('No PHP-FPM is active; check php-fpm with systemctl.')
      }
      if (!skipDns && dnsMode === 'safe') {
        if (!(await active('valet-studio-dns'))) throw new Error('The safe DNS service is not active.')
        if (!(await active('systemd-resolved'))) throw new Error('systemd-resolved is not running.')
      }
      if (!skipDns) {
        const domain = await valetDomain().catch(() => 'test')
        const check = await run('getent', ['hosts', `valet-studio.${domain}`], true)
        if (!check.includes('127.0.0.1')) throw new Error(`Could not resolve valet-studio.${domain}.`)
      }
      emit({ type: 'log', text: `Valet ready: ${version.split('\n')[0]}\n` })
    }),
    S('smoke', 'Test a site end to end', async () => {
      smoke = await smokeTest(parkDir, emit)
      return smoke.state === 'skip' ? 'skip' : undefined
    }),
    S('mariadb', 'Prepare MariaDB and its managed user', async () => {
      if (!withMariaDb) return 'skip'
      if (!(await mariaDbServerInstalled())) {
        throw new Error('MariaDB is not installed: mariadb-server is missing.')
      }
      if (!(await findMariaDbClient())) {
        throw new Error('The MariaDB client is missing: install mariadb-client or mysql-client.')
      }
      // Arch no crea /var/lib/mysql al instalar el paquete: sin este paso el
      // servicio arranca y muere. En Debian/Ubuntu el postinst ya lo hace.
      if (d.pm === 'pacman' && !existsSync(join(MARIADB_DATA_DIR, 'mysql'))) {
        emit({ type: 'log', text: 'Initializing the MariaDB data directory…\n' })
        await shElevated(emit, 'mariadb-install-db', [
          '--user=mysql', '--basedir=/usr', '--datadir=/var/lib/mysql'
        ])
      }
      await shElevated(emit, 'systemctl', ['enable', '--now', 'mariadb'])
      // Solo prepara el usuario gestionado. El secure (anónimos, test, root)
      // es manual y se abre desde la ficha de seguridad.
      await prepareMariaDb((text) => emit({ type: 'log', text }))
    }),
    S('nvm', 'Install nvm if it is missing', async () => {
      if (!withNode || nvmAvailable()) return 'skip'
      if (!(await has('git'))) throw new Error('git is required to install nvm. Install git and try again.')
      await installNvm((text) => emit({ type: 'log', text }))
    }),
    S('node', `Install Node.js ${NODE_VERSION} with nvm`, async () => {
      if (!withNode) return 'skip'
      if (!existsSync(nvmScript())) throw new Error('nvm is not installed: install it and try again.')
      const env = nvmEnv()
      await sh(emit, 'bash', ['-c', `. "$NVM_SH" && ${nvmNodeCommands().join(' && ')}`], { env })
      const version = (await runWithEnv(
        'bash', ['-c', `. "$NVM_SH" && nvm version ${NODE_VERSION}`], env, true
      )).trim()
      if (!version.startsWith(`v${NODE_VERSION}.`)) {
        throw new Error(`nvm did not install Node.js ${NODE_VERSION}; check the log or run the nvm commands by hand.`)
      }
      emit({ type: 'log', text: `Node.js ${version} is the default in nvm.\n` })
    }),
    S('summary', 'Check the final state', async () => {
      const rows = await collectSummary(phpTarget, withMariaDb, withNode, smoke, skipDns)
      emit({ type: 'summary', rows })
      const failed = rows.filter((r) => r.state === 'fail')
      if (failed.length) {
        throw new Error(`Installation finished with ${failed.length} failing check(s): ${failed.map((r) => r.label).join(', ')}.`)
      }
    })
  ], emit)
}

const uniquePackages = (list: string[]): string[] => [...new Set(list.filter(Boolean))]

/** Nombres instalados de una lista concreta; nunca se pasa un patrón al gestor. */
async function installedSystemPackages(pm: Pm, candidates: string[]): Promise<string[]> {
  if (!candidates.length) return []
  if (pm === 'apt') {
    const out = await run('dpkg-query', ['-W', '-f=${Package}\n', ...candidates], true)
    const found = new Set(out.split('\n').map((line) => line.trim()).filter(Boolean))
    return candidates.filter((name) => found.has(name))
  }
  const out = pm === 'dnf'
    ? await run('rpm', ['-qa', '--qf', '%{NAME}\n'], true)
    : await run('pacman', ['-Qq'], true)
  const found = new Set(out.split('\n').map((line) => line.trim()).filter(Boolean))
  return candidates.filter((name) => found.has(name))
}

/** Paquetes de la versión de PHP que gestiona el panel. */
async function installedPhpPackages(pm: Pm, version: string): Promise<string[]> {
  if (pm === 'apt') {
    const out = await run('dpkg-query', ['-W', '-f=${Package}\n', `php${version}-*`, `php${version}`], true)
    return phpPackagesFromDpkg(version, out)
  }
  const out = pm === 'dnf'
    ? await run('rpm', ['-qa', '--qf', '%{NAME}\n'], true)
    : await run('pacman', ['-Qq'], true)
  return uniquePackages(
    out.split('\n').map((line) => line.trim()).filter((name) => /^php(?:-|$)/.test(name))
  )
}

/**
 * Paquetes reales que quita la purga completa: PHP de la versión gestionada,
 * Composer y MariaDB solo si el panel la instaló. Los sitios y las copias no
 * se tocan.
 */
export async function fullUninstallPackages(env: Env): Promise<string[]> {
  const pm = env.pm as Pm | null
  if (!pm) return []
  const php = env.php.target || env.php.current || PHP_VERSION
  const phpPackages = await installedPhpPackages(pm, php)
  const composer = await installedSystemPackages(pm, ['composer'])
  const mariadb = existsSync(MARIADB_INSTALLED_MARKER)
    ? await installedSystemPackages(pm, uniquePackages([
        ...mariadbPackages(pm), 'mariadb-common', 'mariadb-client-core', 'mariadb-server-core'
      ]))
    : []
  return uniquePackages([...phpPackages, ...composer, ...mariadb])
}

/** Quita de nvm la versión de Node que instaló el panel (26.x). */
async function removeManagedNode(emit: Emit): Promise<boolean> {
  const root = join(nvmDir(), 'versions', 'node')
  const versions = (await readdir(root).catch(() => [] as string[]))
    .filter((version) => version.startsWith(`v${NODE_VERSION}.`))
  if (!versions.length) return false
  for (const version of versions) {
    await rm(join(root, version), { recursive: true, force: true })
    emit({ type: 'log', text: `Removed ${version} from nvm.\n` })
  }
  const alias = join(nvmDir(), 'alias', 'default')
  const target = await readFile(alias, 'utf8').catch(() => '')
  if (versions.some((version) => target.includes(version))) await rm(alias, { force: true })
  return true
}

export async function startUninstall(
  pkgInput: string,
  emit: Emit,
  options: { full?: boolean } = {}
) {
  const pkg = normalizePkg(pkgInput)
  const full = options.full === true
  const before = full ? await checkEnv().catch(() => null) : null
  const packages = before ? await fullUninstallPackages(before).catch(() => [] as string[]) : []
  const pm = (before?.pm ?? null) as Pm | null
  const panelMariaDb = existsSync(MARIADB_INSTALLED_MARKER)
  await requireElevation()
  await prepareInstallScripts()
  await prepareHelpers()
  const isolatedValet = existsSync(join(COMPOSER_BIN, 'valet'))

  const steps: Step[] = [
    {
      id: 'valet',
      label: 'Uninstall Valet services',
      fn: async () => {
        if (!isolatedValet) {
          if (await has('valet')) {
            if (full) {
              emit({ type: 'log', text: 'External Valet detected; it is left untouched.\n' })
              return 'skip'
            }
            throw new Error('There is an external Valet; it is not uninstalled automatically from the dashboard.')
          }
          return 'skip'
        }
        await patchValetDns(pkg, emit)
        await sh(emit, 'valet', ['uninstall'], { extraEnv: { VALET_STUDIO_SAFE_DNS: '1' } })
      }
    },
    { id: 'dns', label: 'Remove dashboard DNS', fn: () => removeDns(emit) },
    {
      id: 'composer',
      label: 'Remove the isolated Composer package',
      fn: async () => {
        const [vendor, name] = pkg.split('/')
        if (!existsSync(join(COMPOSER_HOME, 'vendor', vendor, name))) return 'skip'
        await sh(emit, 'composer', ['global', 'remove', pkg, '--no-interaction', '--no-progress'], {
          env: composerEnv()
        })
      }
    }
  ]

  if (full) {
    steps.push(
      {
        id: 'mariadb-stop',
        label: 'Stop MariaDB',
        fn: async () => {
          if (!panelMariaDb) return 'skip'
          await shElevated(emit, 'systemctl', ['stop', 'mariadb']).catch(() => {
            emit({ type: 'log', text: 'MariaDB was not running.\n' })
          })
        }
      },
      {
        id: 'packages',
        label: 'Purge PHP, Composer and MariaDB',
        fn: async () => {
          if (!packages.length) return 'skip'
          emit({ type: 'log', text: `$ removing ${packages.join(' ')}\n` })
          if (pm === 'apt') {
            await shElevated(emit, 'env', [...APT_ENV, 'apt-get', ...APT_OPTS, 'purge', '-y', ...packages], {
              pm, timeoutMs: PACKAGE_TIMEOUT_MS
            })
          } else if (pm === 'dnf') {
            await shElevated(emit, 'dnf', ['remove', '-y', ...packages], { pm, timeoutMs: PACKAGE_TIMEOUT_MS })
          } else if (pm === 'pacman') {
            await shElevated(emit, 'pacman', ['-Rns', '--noconfirm', ...packages], { pm, timeoutMs: PACKAGE_TIMEOUT_MS })
          } else {
            throw new Error('This system has no compatible package manager for the full uninstall.')
          }
        }
      },
      {
        id: 'node',
        label: `Remove Node.js ${NODE_VERSION} from nvm`,
        fn: async () => (await removeManagedNode(emit)) ? undefined : 'skip'
      },
      {
        id: 'panel',
        label: 'Remove the isolated Composer home and credentials',
        fn: async () => {
          await rm(COMPOSER_HOME, { recursive: true, force: true })
          await rm(join(APP_DIR, 'mariadb.json'), { force: true })
          if (panelMariaDb) await shElevated(emit, 'rm', ['-f', MARIADB_INSTALLED_MARKER])
        }
      }
    )
  }

  await runSteps(steps, emit)
}

export async function repairDns(mode: DnsMode, emit: Emit) {
  if (mode !== 'safe' && mode !== 'hosts') throw new Error('Invalid DNS mode for repair')
  await requireElevation()
  await prepareInstallScripts()
  await prepareHelpers()
  await runSteps([
    {
      id: 'dns',
      label: mode === 'safe' ? 'Apply safe DNS' : 'Sync /etc/hosts',
      fn: () => applyDns(emit, mode)
    }
  ], emit)
}

export async function syncHosts(emit: Emit) {
  await repairDns('hosts', emit)
}


