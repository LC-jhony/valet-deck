// Chrome y Chromium en Linux leen las CAs locales de una base NSS compartida.
// `valet secure` importa el certificado del sitio, pero no la CA que lo firma,
// así que el navegador muestra «la conexión no es privada». Aquí se importa la
// CA de Valet como ancla de confianza. El navegador debe reiniciarse una vez
// para leer la base; Chrome no recarga las CAs mientras está abierto.

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run } from './exec'

const NICKNAME = 'Valet Deck Local CA'

/**
 * Chrome usa `~/.pki/nssdb` si existe; desde la versión 146 el respaldo es
 * `~/.local/share/pki/nssdb`. Si no hay ninguna, se crea la clásica: las
 * versiones nuevas también la prefieren, así funciona en ambas.
 */
export function chromeNssDb(home: string, legacyExists: boolean, modernExists: boolean): string {
  if (legacyExists || !modernExists) return join(home, '.pki', 'nssdb')
  return join(home, '.local', 'share', 'pki', 'nssdb')
}

export function valetCaPath(home: string): string {
  return join(home, '.valet', 'CA', 'LaravelValetCASelfSigned.pem')
}

/**
 * Importa la CA local de Valet en la base NSS de Chrome. Devuelve `false` si
 * no hay CA todavía (nunca se habilitó HTTPS) o si `certutil` no pudo escribir;
 * el sitio sigue siendo válido, solo el navegador mostrará el aviso.
 */
export async function trustValetCa(): Promise<boolean> {
  const home = homedir()
  const ca = valetCaPath(home)
  if (!existsSync(ca)) return false
  const legacy = join(home, '.pki', 'nssdb')
  const modern = join(home, '.local', 'share', 'pki', 'nssdb')
  const db = chromeNssDb(home, existsSync(legacy), existsSync(modern))
  const base = ['-d', `sql:${db}`]
  try {
    await mkdir(db, { recursive: true, mode: 0o700 })
    if (!existsSync(join(db, 'cert9.db'))) {
      await run('certutil', [...base, '-N', '--empty-password'])
    }
    // `-A` falla si la entrada ya existe. Se borra primero para que la CA
    // quede siempre marcada como ancla (`C,,`) y no como simple certificado.
    await run('certutil', [...base, '-D', '-n', NICKNAME], true)
    await run('certutil', [...base, '-A', '-t', 'C,,', '-n', NICKNAME, '-i', ca])
    return true
  } catch {
    return false
  }
}
