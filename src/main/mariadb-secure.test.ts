import { describe, expect, it } from 'vitest'
import { SECURE_SCRIPT, buildSecureScript, pickSecureCommand, planSecureTerminal } from './mariadb-secure'

describe('plan de terminal para mariadb-secure-installation', () => {
  it('prefiere ptyxis: es la terminal por defecto de Ubuntu 24.10+ y no entiende -e', () => {
    const plan = planSecureTerminal(['xterm', 'ptyxis', 'gnome-terminal'])
    expect(plan?.bin).toBe('ptyxis')
    expect(plan?.args).toEqual(['--', 'sh', '-c', SECURE_SCRIPT])
  })

  it('usa -- con gnome-terminal: -e está obsoleto y las opciones del terminal se separan del comando', () => {
    const plan = planSecureTerminal(['gnome-terminal', 'konsole'])
    expect(plan?.bin).toBe('gnome-terminal')
    expect(plan?.args[0]).toBe('--')
    expect(plan?.args.slice(1)).toEqual(['sh', '-c', SECURE_SCRIPT])
  })

  it('usa -x con xfce4-terminal: -e espera un único string', () => {
    const plan = planSecureTerminal(['xfce4-terminal'])
    expect(plan?.bin).toBe('xfce4-terminal')
    expect(plan?.args[0]).toBe('-x')
  })

  it('usa -e con la familia xterm (konsole, mate-terminal, tilix, xterm)', () => {
    for (const bin of ['konsole', 'mate-terminal', 'tilix', 'xterm']) {
      const plan = planSecureTerminal([bin])
      expect(plan?.bin).toBe(bin)
      expect(plan?.args[0]).toBe('-e')
      expect(plan?.args.slice(1)).toEqual(['sh', '-c', SECURE_SCRIPT])
    }
  })

  it('deja x-terminal-emulator como último recurso: el enlace puede apuntar a un terminal que no acepte -e', () => {
    const plan = planSecureTerminal(['x-terminal-emulator'])
    expect(plan?.bin).toBe('x-terminal-emulator')
    expect(plan?.args[0]).toBe('-e')
  })

  it('no elige nada si no hay ninguna terminal instalada', () => {
    expect(planSecureTerminal([])).toBeNull()
  })

  it('el script interno deja la ventana abierta y muestra el código de salida', () => {
    expect(SECURE_SCRIPT).toContain('sudo mariadb-secure-installation')
    expect(SECURE_SCRIPT).toContain('$code')
    expect(SECURE_SCRIPT).toContain('read')
  })
})

describe('elevación del asistente seguro', () => {
  it('usa pkexec cuando no hay sudo con diálogo', () => {
    const script = buildSecureScript({ cmd: 'pkexec', args: [] })
    expect(script).toContain('pkexec mariadb-secure-installation')
    expect(script).not.toContain('sudo')
  })

  it('quita -A de sudo: la terminal ya puede pedir la contraseña', () => {
    const script = buildSecureScript({ cmd: '/usr/bin/sudo', args: ['-A'] })
    expect(script).toContain('/usr/bin/sudo mariadb-secure-installation')
    expect(script).not.toContain('-A')
  })

  it('cita comandos con espacios sin romper el script', () => {
    const script = buildSecureScript({ cmd: '/opt/mi sudo', args: ['--flag'] })
    expect(script).toContain("'/opt/mi sudo' --flag mariadb-secure-installation")
  })
})

describe('asistente seguro según la versión de MariaDB', () => {
  it('prefiere el nombre nuevo cuando existe', () => {
    expect(pickSecureCommand(['mysql_secure_installation', 'mariadb-secure-installation']))
      .toBe('mariadb-secure-installation')
  })

  it('en MariaDB 10.3 (Ubuntu 20.04/20.10) usa mysql_secure_installation', () => {
    expect(pickSecureCommand(['mysql_secure_installation'])).toBe('mysql_secure_installation')
  })

  it('devuelve null si no hay ninguno', () => {
    expect(pickSecureCommand([])).toBeNull()
  })

  it('el guion lanza el comando elegido', () => {
    const script = buildSecureScript({ cmd: '/usr/bin/sudo', args: ['-A'] }, 'mysql_secure_installation')
    expect(script).toContain('/usr/bin/sudo mysql_secure_installation;')
    expect(script).not.toContain('mariadb-secure-installation')
  })
})
