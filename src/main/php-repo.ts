// Repositorio de PHP para apt: estado, errores y ejecución.
//
// La decisión (PPA de Ondřej, Sury o PHP de la distribución, según la versión
// de Ubuntu) vive en shared/php-repo.ts y es pura. Aquí está lo que toca el
// sistema: leer los orígenes de apt para saber si el repositorio ya está
// configurado, añadirlo cuando falta, retirar un Sury obsoleto y construir
// errores accionables.
//
// Dos contextos llaman a esto con ejecutores distintos: el instalador principal
// transmite la salida en vivo y se puede cancelar (shElevated), y la página de
// PHP usa `elevated` simple. La lógica es una sola.

import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PHP_VERSION } from '../shared/stack'
import {
  distroProvidesTargetPhp, phpRepoCommands, phpRepoFor, phpRepoLabel, suryInstallSnippet,
  SURY_LIST, type PhpRepoKind, type PhpRepoState
} from '../shared/php-repo'
import { detectPlatform, planPhp } from './platform'
import { run } from './exec'
import { elevated } from './elevate'

export type { PhpRepoKind, PhpRepoState }

export { suryInstallSnippet }

/** `apt-cache` con salida en inglés: sus campos se clasifican por texto. */
const aptCache = (args: string[]): Promise<string> =>
  run('env', [...APT_CACHE_ENV, 'apt-cache', ...args], true)

// `LC_ALL=C` también para apt-get: los mensajes del instalador se clasifican
// por texto y el registro se lee mejor en un idioma único.
const APT_ENV = ['LC_ALL=C', 'LANGUAGE=C', 'DEBIAN_FRONTEND=noninteractive']
const APT_OPTS = [
  '-o', 'DPkg::Lock::Timeout=120',
  '-o', 'Acquire::http::Timeout=30',
  '-o', 'Acquire::https::Timeout=30',
  '-o', 'Acquire::Retries=3'
]
// apt-cache no eleva pero sí traduce; APT_CACHE_ENV se define tras APT_ENV.
const APT_CACHE_ENV = ['LC_ALL=C', 'LANGUAGE=C']

/** Copia de seguridad de los orígenes de apt que el panel retira. */
const APT_BACKUP_ROOT = join(homedir(), '.valet-studio', 'backups', 'apt')

/** Rutas que toca la retirada del Sury obsoleto (inyectables para las pruebas). */
export interface StaleSuryPaths {
  osRelease: string
  suryList: string
  backupRoot: string
}

const STALE_SURY_PATHS: StaleSuryPaths = {
  osRelease: '/etc/os-release',
  suryList: SURY_LIST,
  backupRoot: APT_BACKUP_ROOT
}

/** ¿Esta Ubuntu ya trae el PHP del panel y arrastra un Sury que no encaja? */
async function hasStaleSuryRepository(paths: StaleSuryPaths = STALE_SURY_PATHS): Promise<boolean> {
  if (!existsSync(paths.suryList)) return false
  const text = await readFile(paths.osRelease, 'utf8').catch(() => '')
  return distroProvidesTargetPhp(detectPlatform(text))
}

let removingStaleSury: Promise<boolean> | null = null

/**
 * Retira el origen de Sury cuando la distribución ya trae el PHP del panel.
 * Ocurre al actualizar de 26.04 a 26.10: la lista sigue apuntando a
 * `resolute` y sus paquetes piden libsodium23, que 26.10 ya no publica, así
 * que apt no puede resolver la instalación ni la actualización de PHP.
 * Guarda una copia en la carpeta de respaldos antes de borrar y refresca los
 * índices. Es idempotente y solo toca el archivo del propio repositorio.
 */
export function removeStaleSuryRepository(runner: PhpRepoRunner, paths: StaleSuryPaths = STALE_SURY_PATHS): Promise<boolean> {
  removingStaleSury ??= removeStaleSuryOnce(runner, paths).finally(() => { removingStaleSury = null })
  return removingStaleSury
}

async function removeStaleSuryOnce(runner: PhpRepoRunner, paths: StaleSuryPaths): Promise<boolean> {
  if (!(await hasStaleSuryRepository(paths))) return false
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(paths.backupRoot, `sury-php.list.${stamp}`)
  try {
    await mkdir(paths.backupRoot, { recursive: true, mode: 0o700 })
    await copyFile(paths.suryList, backup)
    await chmod(backup, 0o600)
  } catch (e) {
    // Sin copia no se borra: mejor un error claro que perder el origen de apt.
    const why = e instanceof Error ? e.message : String(e)
    throw new Error(`Could not save a copy of ${paths.suryList} before removing it: ${why}`)
  }
  runner.log(
    `Removing the obsolete Sury PHP repository (${paths.suryList}): it targets an older Ubuntu ` +
    'release and its packages need libraries this release no longer ships.\n'
  )
  await runner.elevated('rm', ['-f', paths.suryList])
  runner.log(`The original list is saved in ${backup}.\n`)
  runner.log('Refreshing the apt indexes without the stale repository…\n')
  await runner.elevated('env', [...APT_ENV, 'apt-get', ...APT_OPTS, 'update'])
  return true
}

/** ¿El repositorio configurado ofrece el paquete? `apt-cache` sale con 100 si no existe. */
async function aptPackageExists(name: string): Promise<boolean> {
  return (await aptCache(['show', name])).trim() !== ''
}

/** Texto de todos los orígenes de apt conocidos (sources.list y sources.list.d). */
async function aptSourcesText(): Promise<string> {
  const files = ['/etc/apt/sources.list']
  const extra = await readdir('/etc/apt/sources.list.d').catch(() => [] as string[])
  for (const name of extra) if (/\.(list|sources)$/.test(name)) files.push(`/etc/apt/sources.list.d/${name}`)
  const parts = await Promise.all(files.map((f) => readFile(f, 'utf8').catch(() => '')))
  return parts.join('\n')
}

/**
 * Estado del repositorio PHP en esta máquina: cuál se usaría, si ya está
 * configurado, por qué se eligió y cómo añadirlo a mano.
 */
export async function phpRepoState(): Promise<PhpRepoState> {
  const text = await readFile('/etc/os-release', 'utf8').catch(() => '')
  const info = detectPlatform(text)
  const repo = phpRepoFor(info)
  const stale = await hasStaleSuryRepository()
  if (!repo.kind) {
    return {
      kind: null,
      suite: null,
      label: phpRepoLabel(null, null),
      note: planPhp(info, PHP_VERSION).note,
      commands: [],
      enabled: false,
      stale
    }
  }
  const sources = await aptSourcesText()
  const enabled = repo.kind === 'sury'
    ? existsSync(SURY_LIST)
    : /ondrej/i.test(sources)
  return {
    kind: repo.kind,
    suite: repo.suite,
    label: phpRepoLabel(repo.kind, repo.suite),
    note: planPhp(info, PHP_VERSION).note,
    commands: phpRepoCommands(repo.kind, repo.suite),
    enabled,
    stale
  }
}

/** Error accionable cuando apt no ofrece una versión de PHP. */
export function phpRepoError(version: string, repo: PhpRepoState): string {
  const why = repo.note ? ` ${repo.note}` : ''
  const how = repo.commands.length ? ` Add it by hand:\n  ${repo.commands.join('\n  ')}` : ''
  return `PHP ${version} is not available in the configured repositories.${why}${how}`
}

/** Cómo se ejecutan los comandos elevados del repositorio en cada contexto. */
export interface PhpRepoRunner {
  elevated(cmd: string, args: string[]): Promise<unknown>
  log(text: string): void
}

/** Ejecutor para contextos simples (página de PHP): salida al log, sin streaming. */
export const plainRunner = (log: (text: string) => void): PhpRepoRunner => ({
  elevated: (cmd, args) => elevated(cmd, args),
  log
})

/**
 * Añade el repositorio decidido para esta versión de Ubuntu, aunque apt ya
 * ofrezca PHP: es la acción explícita «Add the PHP repository». Refresca los
 * índices al terminar para que `apt-cache` vea los paquetes nuevos.
 */
export async function addConfiguredRepository(runner: PhpRepoRunner): Promise<void> {
  const state = await phpRepoState()
  if (!state.kind || !state.commands.length) {
    throw new Error(
      state.note ??
      'No PHP repository covers this distribution; PHP comes from its own repositories.'
    )
  }
  if (state.kind === 'ppa') {
    if ((await run('which', ['add-apt-repository'], true)).trim() === '') {
      runner.log('Installing software-properties-common for add-apt-repository…\n')
      await runner.elevated('apt-get', [...APT_OPTS, 'install', '-y', 'software-properties-common'])
    }
    runner.log('Adding the Ondřej PHP PPA (ppa:ondrej/php)…\n')
    await runner.elevated('add-apt-repository', ['-y', 'ppa:ondrej/php'])
  } else {
    runner.log(`Adding the Sury PHP repository (suite ${state.suite})…\n`)
    await runner.elevated('bash', ['-c', suryInstallSnippet(state.suite as string)])
  }
  runner.log('Refreshing the apt indexes…\n')
  await runner.elevated('env', [...APT_ENV, 'apt-get', ...APT_OPTS, 'update'])
}

/**
 * Asegura que apt ofrece `php{version}`. Añade el repositorio decidido solo
 * cuando el paquete no está: si ya está, no toca nada. Devuelve `skip` cuando
 * no hizo falta tocar los orígenes.
 */
export async function ensureAptPhpRepository(
  version: string,
  runner: PhpRepoRunner
): Promise<'skip' | void> {
  if (!/^\d+\.\d+$/.test(version)) throw new Error('Invalid PHP version')
  // Un Sury de una versión anterior sigue en apt tras actualizar Ubuntu y
  // rompe cualquier instalación de PHP: se retira antes de mirar paquetes.
  await removeStaleSuryRepository(runner)
  if (await aptPackageExists(`php${version}-cli`)) {
    runner.log(`PHP ${version} is already offered by the configured repositories.\n`)
    return 'skip'
  }
  runner.log(`PHP ${version} is not in the current indexes; refreshing them…\n`)
  await runner.elevated('env', [...APT_ENV, 'apt-get', ...APT_OPTS, 'update'])
  if (await aptPackageExists(`php${version}-cli`)) {
    runner.log(`PHP ${version} appeared after refreshing the indexes.\n`)
    return 'skip'
  }
  const state = await phpRepoState()
  if (!state.kind || !state.commands.length) throw new Error(phpRepoError(version, state))
  await addConfiguredRepository(runner)
  if (!(await aptPackageExists(`php${version}-cli`))) throw new Error(phpRepoError(version, state))
}

/** Acción explícita de la página de PHP: añade el repositorio y refresca. */
export async function addPhpRepository(log: (text: string) => void): Promise<void> {
  await addConfiguredRepository(plainRunner(log))
}
