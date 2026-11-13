// Lectura pura del catálogo de PHP que publica apt. El proceso principal lo
// usa para saber qué parche hay instalado y cuál ofrece el repositorio; al ser
// puro se puede probar sin tocar el sistema.

import { compareVersions } from './site-files'

export interface PhpPackagePolicy {
  installed: string
  candidate: string
}

/** Extrae la versión completa (`8.4.27`) de una cadena de paquete de Debian. */
export function phpPatch(value: string): string | null {
  const match = value.trim().match(/(\d+\.\d+\.\d+)/)
  return match ? match[1] : null
}

/** `php8.4-fpm` → `8.4`; cualquier otro nombre devuelve `null`. */
export function phpMinorFromPackage(pkg: string): string | null {
  return pkg.trim().match(/^php(\d+\.\d+)-fpm$/)?.[1] ?? null
}

/**
 * Parsea la salida de `apt-cache policy php8.4-fpm php8.5-fpm …`.
 * Cada bloque empieza por `paquete:` y trae `Installed:` y `Candidate:`.
 */
export function parseAptPolicy(output: string): Map<string, PhpPackagePolicy> {
  const result = new Map<string, PhpPackagePolicy>()
  let current = ''
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    const header = line.match(/^([a-z0-9][a-z0-9+.-]*):$/)
    if (header) {
      current = header[1]
      continue
    }
    if (!current) continue
    const field = line.match(/^(Installed|Candidate):\s*(.+)$/)
    if (!field) continue
    const entry = result.get(current) ?? { installed: '', candidate: '' }
    if (field[1] === 'Installed') entry.installed = field[2].trim()
    else entry.candidate = field[2].trim()
    result.set(current, entry)
  }
  return result
}

/**
 * Suma los tamaños de descarga de `apt-cache show --no-all-versions`.
 * Devuelve bytes por paquete; los paquetes sin `Size:` se omiten.
 */
export function parseAptShowSize(output: string): Map<string, number> {
  const result = new Map<string, number>()
  let current = ''
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('Package:')) {
      current = line.slice('Package:'.length).trim()
      continue
    }
    if (!current) continue
    const size = line.match(/^Size:\s*(\d+)$/)
    if (!size) continue
    result.set(current, Number(size[1]))
    current = ''
  }
  return result
}

/** `true` cuando el repositorio ofrece un parche más nuevo que el instalado. */
export function hasPhpUpdate(installed: string | null, latest: string | null): boolean {
  return Boolean(installed && latest && compareVersions(latest, installed) > 0)
}
