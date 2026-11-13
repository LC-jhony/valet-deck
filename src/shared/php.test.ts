import { describe, expect, it } from 'vitest'
import {
  hasPhpUpdate, parseAptPolicy, parseAptShowSize, phpMinorFromPackage, phpPatch
} from './php'

describe('phpPatch', () => {
  it('extrae la versión completa de un paquete de Debian', () => {
    expect(phpPatch('8.4.27-1+ubuntu24.04.1+deb.sury.org+1')).toBe('8.4.27')
    expect(phpPatch('8.5.9-0ubuntu2.1')).toBe('8.5.9')
    expect(phpPatch('(none)')).toBeNull()
  })
})

describe('phpMinorFromPackage', () => {
  it('solo acepta el paquete fpm de una versión', () => {
    expect(phpMinorFromPackage('php8.4-fpm')).toBe('8.4')
    expect(phpMinorFromPackage('php8.10-fpm')).toBe('8.10')
    expect(phpMinorFromPackage('php8.4-cli')).toBeNull()
  })
})

describe('parseAptPolicy', () => {
  it('lee Installed y Candidate de la salida en inglés', () => {
    const out = [
      'php8.4-fpm:',
      '  Installed: 8.4.26-1+deb.sury.org+1',
      '  Candidate: 8.4.27-1+deb.sury.org+1',
      '  Version table:',
      ' *** 8.4.27-1+deb.sury.org+1 500',
      'php8.5-fpm:',
      '  Installed: (none)',
      '  Candidate: 8.5.12-1+deb.sury.org+1',
      '  Version table:'
    ].join('\n')
    const parsed = parseAptPolicy(out)
    expect(parsed.get('php8.4-fpm')).toEqual({
      installed: '8.4.26-1+deb.sury.org+1',
      candidate: '8.4.27-1+deb.sury.org+1'
    })
    expect(parsed.get('php8.5-fpm')).toEqual({
      installed: '(none)',
      candidate: '8.5.12-1+deb.sury.org+1'
    })
  })
})

describe('parseAptShowSize', () => {
  it('suma el Size de cada bloque sin confundirlo con Installed-Size', () => {
    const out = [
      'Package: php8.4-fpm',
      'Installed-Size: 12000',
      'Size: 3226924',
      '',
      'Package: php8.4-cli',
      'Installed-Size: 5000',
      'Size: 1850000'
    ].join('\n')
    const sizes = parseAptShowSize(out)
    expect(sizes.get('php8.4-fpm')).toBe(3226924)
    expect(sizes.get('php8.4-cli')).toBe(1850000)
  })
})

describe('hasPhpUpdate', () => {
  it('solo avisa cuando el repositorio tiene un parche mayor', () => {
    expect(hasPhpUpdate('8.4.26', '8.4.27')).toBe(true)
    expect(hasPhpUpdate('8.4.27', '8.4.27')).toBe(false)
    expect(hasPhpUpdate('8.5.0', '8.4.27')).toBe(false)
    expect(hasPhpUpdate(null, '8.4.27')).toBe(false)
    expect(hasPhpUpdate('8.4.27', null)).toBe(false)
  })
})
