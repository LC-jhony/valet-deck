// Elevación de privilegios con alternativa. Se prefiere `sudo -A` con nuestro
// diálogo (sudo recuerda la contraseña unos minutos: una sola ventana para toda
// la instalación) y `pkexec` queda como respaldo cuando no hay sudo o zenity.
// La elección es una función pura (`planElevation`) para probarla sin tocar el sistema.
import { existsSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { ASKPASS, ensureAskpass } from './askpass'
import { env, run, runInput, runWithEnv } from './exec'

export type Elevation = { cmd: 'pkexec' | '/usr/bin/sudo'; prefix: string[] }

/** Preferencia: sudo con askpass (caché); si no, pkexec. `null` si no hay forma. */
export function planElevation(hasPkexec: boolean, hasSudo: boolean, askpass: string | null): Elevation | null {
  if (hasSudo && askpass) return { cmd: '/usr/bin/sudo', prefix: ['-A'] }
  if (hasPkexec) return { cmd: 'pkexec', prefix: [] }
  return null
}

export const SUDO = '/usr/bin/sudo'

const hasCommand = async (cmd: string): Promise<boolean> => (await run('which', [cmd], true)).trim() !== ''

/** Detecta cómo se puede elevar en este sistema. */
export async function detectElevation(): Promise<'pkexec' | 'sudo' | null> {
  const how = await currentElevation()
  if (!how) return null
  return how.cmd === 'pkexec' ? 'pkexec' : 'sudo'
}

let cached: Elevation | null | undefined

async function currentElevation(): Promise<Elevation | null> {
  if (cached) return cached
  const plan = planElevation(
    await hasCommand('pkexec'),
    existsSync(SUDO),
    (await hasCommand('zenity')) || (await hasCommand('kdialog')) ? ASKPASS : null
  )
  if (plan) cached = plan
  return plan
}

const sudoEnv = (): NodeJS.ProcessEnv => ({ ...env, SUDO_ASKPASS: ASKPASS })

// sudo traduce sus mensajes al idioma del sistema; se aceptan inglés y español.
const CANCELLED = /authentication is required, but was not attempted|no password was provided|se requiere autentificaci[oó]n, pero no se intent[oó]/i
const WRONG_PASSWORD = /incorrect password|sorry, try again|contrase[nñ]a incorrect|int[eé]ntelo (?:de nuevo|otra vez)/i

/**
 * Traduce un fallo de sudo/pkexec a un mensaje accionable. La cancelación se
 * normaliza a "Operation cancelled", que la interfaz trata como no-error.
 */
export function elevationFailure(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e))
  const code = (err as Error & { code?: number | string }).code
  // 126/127 son los códigos de pkexec al cerrar el diálogo o no autorizar.
  // Un binario ausente también puede dar 127: ese caso no es una cancelación.
  if ((code === 126 || code === 127) && !/not found|no such file/i.test(err.message)) {
    return new Error('Operation cancelled')
  }
  if (CANCELLED.test(err.message)) return new Error('Operation cancelled')
  if (WRONG_PASSWORD.test(err.message)) {
    return new Error('The administrator password was not accepted. Try again.')
  }
  return err
}

/**
 * Comando y argumentos con los que elevar, para quien necesite lanzar el
 * proceso con su propia salida (el instalador lo hace con `spawn`).
 */
export async function elevationCommand(): Promise<{ cmd: string; args: string[] } | null> {
  const how = await currentElevation()
  if (!how) return null
  if (how.cmd === 'pkexec') return { cmd: 'pkexec', args: [] }
  await ensureAskpass()
  return { cmd: SUDO, args: how.prefix }
}

/**
 * Ejecuta un comando como root. Lanza un error explicable si no hay forma de
 * elevar: el mensaje lo muestra la guía de requisitos. `onSpawn` entrega el
 * proceso lanzado, para trabajos largos que se puedan cancelar.
 */
export async function elevated(
  cmd: string,
  args: string[] = [],
  onSpawn?: (child: ChildProcess) => void
): Promise<string> {
  const how = await currentElevation()
  if (!how) {
    throw new Error('No elevation method: install polkit (pkexec) or sudo with zenity')
  }
  if (how.cmd === 'pkexec') {
    try {
      return await run('pkexec', [cmd, ...args], false, undefined, onSpawn)
    } catch (e) {
      throw elevationFailure(e)
    }
  }
  await ensureAskpass()
  try {
    return await runWithEnv(SUDO, [...how.prefix, cmd, ...args], sudoEnv(), false, undefined, onSpawn)
  } catch (e) {
    throw elevationFailure(e)
  }
}

/** Igual que {@link elevated}, con datos por la entrada estándar (secretos). */
export async function elevatedInput(cmd: string, args: string[], input: string): Promise<string> {
  const how = await currentElevation()
  if (!how) {
    throw new Error('No elevation method: install polkit (pkexec) or sudo with zenity')
  }
  if (how.cmd === 'pkexec') {
    try {
      return await runInput('pkexec', [cmd, ...args], input)
    } catch (e) {
      throw elevationFailure(e)
    }
  }
  await ensureAskpass()
  try {
    return await runInput(SUDO, [...how.prefix, cmd, ...args], input, false, sudoEnv())
  } catch (e) {
    throw elevationFailure(e)
  }
}

/** Compatibilidad con el nombre anterior: eleva y devuelve la salida. */
export const sudo = (cmd: string, args: string[] = []): Promise<string> => elevated(cmd, args)
