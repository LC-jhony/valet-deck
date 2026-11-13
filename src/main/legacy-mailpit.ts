// Migración desde 0.3.x: la versión anterior gestionaba Mailpit como servicio
// de usuario. La 0.4.0 trae su propio catcher; si el servicio antiguo sigue
// activo ocupa 2525/1025 y los `.env` existentes entregarían allí. Se detiene y
// se retira una vez, sin borrar los mensajes que Mailpit ya tenía en disco.

import { existsSync } from 'node:fs'
import { rmdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run } from './exec'

export const LEGACY_MAILPIT_UNIT = 'valet-studio-mailpit.service'

export interface LegacyMailpitPaths {
  /** Unidad de usuario que arrancaba Mailpit con la sesión. */
  unit: string
  /** Binario descargado por la versión anterior. */
  binary: string
  /** Base de datos de Mailpit: se conserva para no perder mensajes. */
  data: string
}

export function legacyMailpitPaths(home: string = homedir()): LegacyMailpitPaths {
  return {
    unit: join(home, '.config', 'systemd', 'user', LEGACY_MAILPIT_UNIT),
    binary: join(home, '.valet-studio', 'bin', 'mailpit'),
    data: join(home, '.valet-studio', 'mailpit')
  }
}

export type LegacyRunner = (cmd: string, args: string[], lenient?: boolean) => Promise<string>

/**
 * Detiene, deshabilita y retira el Mailpit de versiones anteriores.
 * Devuelve `true` si encontró restos que limpiar. Los errores de systemd no
 * abortan: el binario y la unidad se retiran igualmente.
 */
export async function removeLegacyMailpit(
  home: string = homedir(),
  runCmd: LegacyRunner = run
): Promise<boolean> {
  const paths = legacyMailpitPaths(home)
  if (!existsSync(paths.unit) && !existsSync(paths.binary)) return false

  const systemctl = (args: string[]): Promise<string> =>
    runCmd('systemctl', ['--user', ...args], true).catch(() => '')

  await systemctl(['stop', LEGACY_MAILPIT_UNIT])
  await systemctl(['disable', LEGACY_MAILPIT_UNIT])
  await unlink(paths.unit).catch(() => '')
  await systemctl(['daemon-reload'])
  await unlink(paths.binary).catch(() => '')
  // Solo borra `bin/` si queda vacío; otras herramientas del panel viven ahí.
  await rmdir(join(home, '.valet-studio', 'bin')).catch(() => '')
  return true
}
