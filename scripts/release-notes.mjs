#!/usr/bin/env node
// Extrae de CHANGELOG.md la sección de una versión. Se usa en el flujo de
// release y desde scripts/release.mjs para no duplicar el formato.
//
//   node scripts/release-notes.mjs 0.1.0            # imprime las notas
//   node scripts/release-notes.mjs 0.1.0 notas.md   # las escribe en un archivo
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Devuelve la sección `## [version]` hasta el siguiente encabezado de versión. */
export function changelogSection(version) {
  const body = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const start = body.indexOf(`## [${version}]`)
  if (start < 0) throw new Error(`CHANGELOG.md has no ${version} section`)
  const next = body.indexOf('\n## [', start + 1)
  return `${body.slice(start, next < 0 ? undefined : next).trim()}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const version = process.argv[2] || pkg.version
  const out = process.argv[3]
  const section = changelogSection(version)
  if (out) writeFileSync(out, section)
  else process.stdout.write(section)
}
