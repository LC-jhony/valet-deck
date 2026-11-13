#!/usr/bin/env node
// Prepara y publica una versión de Valet Deck.
//
//   npm run release            # compila y deja los artefactos listos, sin subir
//   npm run release -- --publish
//
// Además de compilar, deja `latest-linux.yml` con los tres artefactos: el .rpm
// lo genera scripts/build-rpm.sh y electron-builder no lo conoce, así que sin
// esta corrección los usuarios de rpm nunca recibirían la actualización.
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync, readFileSync, statSync, writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changelogSection } from './release-notes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const tag = `v${version}`
const publish = process.argv.includes('--publish')
const skipBuild = process.argv.includes('--no-build')

const die = (message) => {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

const run = (cmd, args, opts = {}) => {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts })
  if (result.status !== 0) die(`${cmd} ${args.join(' ')} failed`)
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

const appImage = join(DIST, `Valet-Deck-${version}.AppImage`)
const deb = join(DIST, `valet-deck_${version}_amd64.deb`)
const rpm = join(DIST, `valet-deck-${version}.x86_64.rpm`)
const updateYml = join(DIST, 'latest-linux.yml')
const notes = join(DIST, `RELEASE_NOTES-${version}.md`)
const sums = join(DIST, 'SHA256SUMS')

if (!skipBuild) {
  // Nunca se publica desde el build: la release la crea este script al final.
  run('npm', ['run', 'dist'])
}

for (const file of [appImage, deb, rpm, updateYml]) {
  if (!existsSync(file)) die(`Missing artifact: ${file}. Run npm run dist first.`)
}

const sha512 = (file) => createHash('sha512').update(readFileSync(file)).digest('base64')
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const sizeOf = (file) => statSync(file).size
const unquote = (value) => value.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')

/**
 * Reescribe `latest-linux.yml` con los tres artefactos. Se parsea el fichero y
 * se vuelve a escribir con un orden fijo: electron-builder solo conoce AppImage
 * y .deb, y el .rpm lo genera otro script, así que hay que añadirlo aquí o los
 * usuarios de rpm nunca verían la actualización.
 */
function rewriteUpdateYml() {
  const top = new Map()
  const entries = []
  let blockSeen = false
  let inFiles = false

  for (const line of readFileSync(updateYml, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    if (!inFiles) {
      if (/^files:\s*$/.test(line)) { blockSeen = true; inFiles = true; continue }
      const key = line.match(/^([\w-]+):\s*(.*)$/)
      if (key) top.set(key[1], key[2])
      continue
    }
    const entry = line.match(/^\s+(?:- )?([\w-]+):\s*(.*)$/)
    if (entry) {
      if (entry[1] === 'url') entries.push({ url: unquote(entry[2]) })
      else if (entries.length) entries[entries.length - 1][entry[1]] = entry[2]
      continue
    }
    inFiles = false
  }

  if (!blockSeen) die(`${updateYml} has no files: block`)
  const blockMapSize = entries.find((entry) => entry.url === basename(appImage))?.blockMapSize

  const files = [
    { url: basename(appImage), file: appImage, extra: blockMapSize ? { blockMapSize } : {} },
    { url: basename(deb), file: deb, extra: {} },
    { url: basename(rpm), file: rpm, extra: {} }
  ]

  const lines = [`version: ${top.get('version') ?? version}`, 'files:']
  for (const item of files) {
    lines.push(`  - url: ${item.url}`)
    lines.push(`    sha512: ${sha512(item.file)}`)
    lines.push(`    size: ${sizeOf(item.file)}`)
    for (const [key, value] of Object.entries(item.extra)) lines.push(`    ${key}: ${value}`)
  }
  lines.push(`path: ${basename(appImage)}`)
  lines.push(`sha512: ${sha512(appImage)}`)
  lines.push(`releaseDate: ${top.get('releaseDate') ?? `'${new Date().toISOString()}'`}`)
  for (const [key, value] of top) {
    if (!['version', 'path', 'sha512', 'releaseDate'].includes(key)) lines.push(`${key}: ${value}`)
  }
  writeFileSync(updateYml, `${lines.join('\n')}\n`)
}

rewriteUpdateYml()

const sumsBody = [appImage, deb, rpm]
  .map((file) => `${sha256(file)}  ${basename(file)}`)
  .join('\n')
writeFileSync(sums, `${sumsBody}\n`)

if (!existsSync(notes)) {
  writeFileSync(notes, changelogSection(version))
  console.log(`==> Notas generadas desde CHANGELOG.md: ${notes}`)
}

console.log(`\n==> ${tag} listo`)
for (const file of [appImage, deb, rpm, sums, updateYml]) {
  console.log(`    ${basename(file)} (${(sizeOf(file) / 1024 / 1024).toFixed(1)} MB)`)
}

if (!publish) {
  console.log('\nSin subir. Cuando quieras publicarlo:\n')
  console.log(`  git push origin main`)
  console.log(`  gh release create ${tag} --title "Valet Deck ${version}" --notes-file ${notes} \\`)
  console.log(`    "${appImage}" "${deb}" "${rpm}" "${sums}" "${updateYml}"\n`)
  process.exit(0)
}

if (git('status', '--porcelain')) die(`The working tree is not clean. Commit the ${version} changes first.`)
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') die(`Publish from main, not ${branch}.`)
const head = git('rev-parse', 'HEAD')
const upstream = git('rev-parse', '@{u}')
if (head !== upstream) die('The local branch has commits that are not pushed. Run git push origin main first.')

const auth = spawnSync('gh', ['auth', 'status'], { cwd: ROOT, stdio: 'ignore' })
if (auth.status !== 0) die('gh is not installed or not authenticated. Run: gh auth login')

const assets = [appImage, deb, rpm, sums, updateYml]
const existing = spawnSync('gh', ['release', 'view', tag], { cwd: ROOT, stdio: 'ignore' })
if (existing.status === 0) {
  console.log(`\n==> La release ${tag} ya existe: se reemplazan los artefactos`)
  run('gh', ['release', 'upload', tag, '--clobber', ...assets])
} else {
  run('gh', ['release', 'create', tag, '--title', `Valet Deck ${version}`, '--notes-file', notes, ...assets])
}

console.log(`\n==> Publicado: https://github.com/${pkg.build.publish.owner}/${pkg.build.publish.repo}/releases/tag/${tag}\n`)
