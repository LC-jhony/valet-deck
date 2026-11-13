import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const TEMPLATE = join(process.cwd(), 'build/linux/after-remove.tpl')

/** Sintaxis de un script bash, sin ejecutarlo: `bash -n`. */
async function syntaxOk(script: string): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'vd-postrm-'))
  const file = join(dir, 'script.sh')
  await writeFile(file, script, { mode: 0o600 })
  try {
    await run('bash', ['-n', file])
    return true
  } catch {
    return false
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** El bloque que se ejecuta en diferido, entre `<<'CLEANUP_EOF'` y `CLEANUP_EOF`. */
function cleanupBlock(template: string): string {
  const start = template.indexOf("<<'CLEANUP_EOF'\n")
  expect(start).toBeGreaterThan(-1)
  const body = template.slice(start + "<<'CLEANUP_EOF'\n".length)
  const end = body.indexOf('\nCLEANUP_EOF\n')
  expect(end).toBeGreaterThan(-1)
  return body.slice(0, end)
}

describe('postrm de Valet Deck', () => {
  it('es bash válido, tanto el script como el bloque de purgado diferido', async () => {
    const template = await readFile(TEMPLATE, 'utf8')
    expect(await syntaxOk(template)).toBe(true)
    expect(await syntaxOk(cleanupBlock(template))).toBe(true)
  })

  it('no deja macros ${...} sin resolver: electron-builder aborta el empaquetado', async () => {
    const template = await readFile(TEMPLATE, 'utf8')
    expect(template.match(/\$\{[a-zA-Z]+\}/g)).toBeNull()
  })

  it('solo limpia en remove y purge; una actualización no toca nada', async () => {
    const template = await readFile(TEMPLATE, 'utf8')
    expect(template).toContain('remove|purge')
    expect(template).toMatch(/remove\|purge\)\s*;;[\s\S]*?\)\s*exit 0/)
  })

  it('no llama a apt-get dentro de la transacción: programa el purgado con systemd-run', async () => {
    const template = await readFile(TEMPLATE, 'utf8')
    const block = cleanupBlock(template)
    // Fuera del bloque diferido no puede haber ni una llamada a apt-get: el
    // lock de apt seguiría tomado y el script se quedaría esperando.
    const outside = template.replace(block, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    expect(outside).not.toContain('apt-get')
    expect(block).toContain('apt-get')
    expect(template).toContain('systemd-run')
    expect(template).toContain('--on-active=')
    // Y hay un camino sin systemd: setsid en segundo plano.
    expect(template).toContain('setsid')
  })

  it('purga el stack que trajo el panel y respeta otras versiones de PHP', async () => {
    const template = await readFile(TEMPLATE, 'utf8')
    const block = cleanupBlock(template)
    for (const pkg of [
      'nginx', 'composer', 'dnsmasq-base', 'libnss3-tools',
      'php8.5-cli', 'php8.5-fpm', 'php8.5-mysql',
      'mariadb-server', 'mariadb-client'
    ]) {
      expect(block).toContain(pkg)
    }
    // Nada de `php*` a lo bruto: se lleva la 8.5 del panel y deja el resto.
    expect(block).not.toMatch(/purge\s+php\*/)
  })

  it('solo para y purga MariaDB si el panel la instaló', async () => {
    const template = await readFile(TEMPLATE, 'utf8')
    const block = cleanupBlock(template)
    // El servicio no está en el bucle incondicional.
    expect(template).not.toMatch(/for svc in[^;]*mariadb/)
    expect(template).toMatch(/if \[ -f \/var\/lib\/valet-studio\/mariadb \]; then\s+systemctl disable --now mariadb/)
    // El purgado está detrás del marcador.
    expect(block).toMatch(/if \[ -f \/var\/lib\/valet-studio\/mariadb \]; then[\s\S]*?mariadb-server/)
    // Y el marcador se retira al terminar.
    expect(block).toContain('rm -rf /var/lib/valet-studio')
  })

  it('elimina Node.js 26 de nvm y conserva nvm y las demás versiones', async () => {
    const block = cleanupBlock(await readFile(TEMPLATE, 'utf8'))
    expect(block).toContain('.nvm/versions/node')
    expect(block).toMatch(/v26\*/)
    expect(block).not.toMatch(/rm -rf[^\n]*\.nvm(\s|$)/)
  })

  it('retira la configuración de Valet que dpkg no conoce y respeta un Valet externo', async () => {
    const template = await readFile(TEMPLATE, 'utf8')
    expect(template).toContain('/etc/nginx/sites-enabled/valet.conf')
    expect(template).toContain('/etc/php/*/fpm/pool.d/valet.conf')
    // El enlace solo se borra si apuntaba al Composer aislado del panel.
    expect(template).not.toContain('rm -f /usr/bin/valetdeck /usr/local/bin/valet')
    expect(template).toMatch(/case "\$VALET_LINK" in[\s\S]*?rm -f \/usr\/local\/bin\/valet/)
  })

  it('para servicios, deshace el DNS y retira los ayudantes de root', async () => {
    const template = await readFile(TEMPLATE, 'utf8')
    expect(template).toContain('systemctl disable --now')
    expect(template).toContain('dns-helper.sh remove')
    expect(template).toContain("rm -rf /usr/local/libexec/valet-studio")
    expect(template).toContain('# BEGIN VALET STUDIO')
  })
})
