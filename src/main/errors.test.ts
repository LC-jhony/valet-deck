import { describe, expect, it } from 'vitest'
import { classify, cleanDialogNoise, commandLabel } from './errors'

describe('clasificación de errores de instalación', () => {
  it('reconoce el bloqueo del gestor de paquetes', () => {
    const e = classify({
      cmd: 'pkexec', code: 100, pm: 'apt',
      stderr: 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1234'
    })
    expect(e.title).toBe('Another package manager is in use')
    expect(e.commands).toContain('ps aux | grep -E "apt|dpkg|packagekitd"')
  })

  it('reconoce el disco lleno', () => {
    const e = classify({ cmd: 'apt-get', code: 1, stderr: 'E: No space left on device' })
    expect(e.title).toBe('Disk full')
    expect(e.commands).toContain('df -h /')
  })

  it('reconoce la falta de red', () => {
    const e = classify({ cmd: 'apt-get', code: 100, pm: 'apt', stderr: 'Temporary failure resolving deb.debian.org' })
    expect(e.title).toBe('No network or broken DNS')
    expect(e.commands).toContain('sudo apt-get update')
  })

  it('reconoce una descarga cortada por el espejo', () => {
    const e = classify({
      cmd: 'apt-get', code: 100, pm: 'apt',
      stderr: 'Err:1 http://pe.archive.ubuntu.com/ubuntu nginx\n  Timeout was reached [200.236.31.4]'
    })
    expect(e.title).toBe('The package download failed')
    expect(e.detail).toContain('Timeout was reached')
    expect(e.commands).toContain('sudo apt-get update')
  })

  it('extrae el paquete que no existe', () => {
    const e = classify({ cmd: 'apt-get', code: 100, pm: 'apt', stderr: 'E: Unable to locate package php8.5-fpm' })
    expect(e.title).toContain('php8.5-fpm')
    expect(e.commands).toContain('sudo apt-get install -y php8.5-fpm')
  })

  it('reconoce un fallo de nvm sin confundirlo con un paquete', () => {
    const e = classify({
      cmd: 'bash', code: 1,
      args: ['-c', '. "$NVM_SH" && nvm install 26'],
      stderr: 'nvm: install failed'
    })
    expect(e.title).toBe('Node.js could not be installed with nvm')
    expect(e.commands).toEqual(['nvm install 26', 'nvm alias default 26'])
  })

  it('reconoce conflictos de dnf y paquetes ausentes en pacman', () => {
    expect(classify({ cmd: 'dnf', code: 1, pm: 'dnf', stderr: 'Transaction check error: file /x conflicts' }).title)
      .toBe('Package conflict')
    expect(classify({ cmd: 'pacman', code: 1, pm: 'pacman', stderr: 'error: target not found: nginx' }).title)
      .toBe('Package not available in pacman')
  })

  it('reconoce cuando Valet no puede instalar php-fpm con apt', () => {
    const e = classify({
      cmd: 'valet', args: ['use', '8.5'], code: 1, pm: 'apt',
      stderr: 'Disabling php8.3-fpm...\nChanging version failed\nApt was unable to install [php8.5-fpm].'
    })
    expect(e.title).toBe('Could not install php8.5-fpm')
    expect(e.hint).toContain('Ondrej PPA')
    expect(e.commands).toContain('sudo add-apt-repository ppa:ondrej/php')
    expect(e.commands).toContain('sudo apt-get install -y php8.5-fpm')
  })

  it('traduce la cancelación del diálogo de polkit', () => {
    expect(classify({ cmd: 'pkexec', code: 126 }).title).toBe('Authentication cancelled')
    expect(classify({ cmd: 'pkexec', code: 127 }).title).toBe('Authentication cancelled')
  })

  it('no confunde un binario ausente (también 127) con autenticación cancelada', () => {
    const e = classify({ cmd: 'pkexec', code: 127, stderr: 'pkexec: command not found' })
    expect(e.title).toBe('pkexec was not found')
  })

  it('distingue el tiempo agotado', () => {
    const e = classify({ cmd: 'apt-get', code: null, killed: true, pm: 'apt' })
    expect(e.title).toBe('The command did not finish in time')
    expect(e.commands[0]).toContain('apt')
  })

  it('al agotarse el tiempo muestra la última descarga y el comando real', () => {
    const e = classify({
      cmd: '/usr/bin/sudo',
      args: ['/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', '-o', 'Acquire::Retries=3', 'install', '-y', 'nginx'],
      killed: true,
      pm: 'apt',
      timeoutMs: 1_800_000,
      stderr: 'Des:1 http://pe.archive.ubuntu.com nginx [100 kB]\rDes:2 http://pe.archive.ubuntu.com mariadb [200 kB]\r'
    })
    expect(e.detail).toContain('apt-get install')
    expect(e.detail).toContain('30 minutes')
    expect(e.detail).toContain('mariadb [200 kB]')
    expect(e.hint).toContain('PackageKit')
    expect(e.commands).toContain('sudo systemctl status packagekit unattended-upgrades --no-pager')
  })

  it('nombra el comando real aunque vaya envuelto en sudo y env', () => {
    expect(commandLabel('/usr/bin/sudo',
      ['-A', '/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', '-o', 'DPkg::Lock::Timeout=120', 'install', '-y', 'nginx']
    )).toBe('apt-get install')
    expect(commandLabel('valet', ['use', '8.5'])).toBe('valet use')
  })

  it('cae en un mensaje genérico con las últimas líneas', () => {
    const e = classify({ cmd: 'valet', code: 1, stderr: 'línea 1\nlínea 2\nlínea 3\nlínea 4' })
    expect(e.title).toBe('valet failed')
    expect(e.detail).toContain('línea 4')
    expect(e.detail).not.toContain('línea 1')
    expect(e.commands).toEqual([])
  })

  it('quita los avisos de zenity/GTK antes de mostrar el error', () => {
    const stderr = [
      '(zenity:18256): Gtk-WARNING **: 19:47:52.060: Trying to measure AdwMessageDialog 0x1 for height of 272, but it needs at least 275',
      '(zenity:18256): Gtk-WARNING **: 19:47:52.077: Trying to measure AdwMessageDialog 0x1 for height of 272, but it needs at least 275',
      'sudo: se requiere autentificación, pero no se intentó'
    ].join('\n')
    expect(cleanDialogNoise(stderr)).toBe('sudo: se requiere autentificación, pero no se intentó')
    const e = classify({ cmd: 'sudo', code: 1, stderr })
    expect(e.title).toBe('sudo failed')
    expect(e.detail).not.toContain('Gtk-WARNING')
    expect(e.detail).toContain('autentificación')
  })
})
