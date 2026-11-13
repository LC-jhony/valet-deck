// nvm no se descarga con un script remoto: se clona su repositorio en la
// etiqueta fijada y se comprueba el commit antes de ejecutar nada. Así una
// etiqueta movida o un clon manipulado no se aceptan en silencio.
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NVM_COMMIT, NVM_REPO, NVM_TAG } from '../shared/stack'
import { runWithEnv } from './exec'
import { unprivilegedEnv } from './helpers'

/** Directorio de nvm. `NVM_DIR` manda si la aplicación se abrió desde una shell. */
export const nvmDir = (): string => process.env.NVM_DIR || join(homedir(), '.nvm')
export const nvmScript = (): string => join(nvmDir(), 'nvm.sh')
export const nvmAvailable = (): boolean => existsSync(nvmScript())

/** Entorno para cargar nvm sin los ayudantes de sudo que usa Valet. */
export const nvmEnv = (): NodeJS.ProcessEnv =>
  unprivilegedEnv({ NVM_DIR: nvmDir(), NVM_SH: nvmScript(), GIT_TERMINAL_PROMPT: '0' })

export type NvmLog = (text: string) => void

/**
 * Clona nvm en la etiqueta fijada si falta. Nunca sobrescribe un `~/.nvm`
 * existente: si hay restos sin `nvm.sh`, se pide moverlos a mano.
 */
export async function installNvm(log: NvmLog): Promise<void> {
  if (nvmAvailable()) return
  const dir = nvmDir()
  if (existsSync(dir)) {
    throw new Error(`${dir} already exists but does not contain nvm.sh. Move it away before installing nvm.`)
  }

  log(`$ git clone --depth 1 --branch ${NVM_TAG} ${NVM_REPO} ${dir}\n`)
  try {
    await runWithEnv(
      'git',
      ['clone', '--depth', '1', '--branch', NVM_TAG, '--single-branch', NVM_REPO, dir],
      nvmEnv()
    )
  } catch (e) {
    // El clon pudo dejar una carpeta a medias; se retira para que el reintento
    // no choque con «ya existe».
    await rm(dir, { recursive: true, force: true }).catch(() => '')
    throw e
  }

  const head = (await runWithEnv('git', ['-C', dir, 'rev-parse', 'HEAD'], nvmEnv(), true)).trim()
  if (head !== NVM_COMMIT) {
    await rm(dir, { recursive: true, force: true }).catch(() => '')
    throw new Error(`nvm was cloned at ${head || 'an unknown commit'}, not the pinned ${NVM_COMMIT}. The folder was removed.`)
  }
  if (!existsSync(join(dir, 'nvm.sh'))) {
    await rm(dir, { recursive: true, force: true }).catch(() => '')
    throw new Error('nvm.sh was not found after cloning nvm.')
  }
  log(`nvm ${NVM_TAG} installed at ${dir} (commit ${head.slice(0, 7)} verified).\n`)
}
