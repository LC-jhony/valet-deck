import { describe, expect, it } from 'vitest'
import type { PhpInstallJob } from '../shared/site'
import { phpPackagesFromDpkg, removeBlocker } from './php-versions'

const running: PhpInstallJob = {
  action: 'install',
  state: 'running',
  phase: 'installing',
  progress: -1,
  error: '',
  startedAt: '2026-01-01T00:00:00.000Z'
}

describe('phpPackagesFromDpkg', () => {
  it('incluye el paquete base y todas sus extensiones de esa versión', () => {
    const output = [
      'php8.4',
      'php8.4-cli',
      'php8.4-fpm',
      'php8.4-mbstring',
      'php8.4-xml',
      'php8.3-fpm',
      'php8.4-common:amd64'
    ].join('\n')
    expect(phpPackagesFromDpkg('8.4', output)).toEqual([
      'php8.4',
      'php8.4-cli',
      'php8.4-common:amd64',
      'php8.4-fpm',
      'php8.4-mbstring',
      'php8.4-xml'
    ])
  })

  it('no confunde 8.4 con 8.40 ni con 8.4x', () => {
    expect(phpPackagesFromDpkg('8.4', 'php8.40-cli\nphp8.4x\nphp8.5-fpm')).toEqual([])
  })

  it('ignora líneas vacías y espacios de dpkg-query', () => {
    expect(phpPackagesFromDpkg('8.1', '\n  php8.1-cli  \n\n')).toEqual(['php8.1-cli'])
  })

  it('rechaza una versión que no es major.minor', () => {
    expect(() => phpPackagesFromDpkg('8', 'php8-cli')).toThrow('Invalid PHP version')
    expect(() => phpPackagesFromDpkg('8.4; rm -rf /', 'php8.4-cli')).toThrow('Invalid PHP version')
  })
})

describe('removeBlocker', () => {
  it('deja quitar una versión libre', () => {
    expect(removeBlocker('8.3', '8.5', [], null)).toBeNull()
    expect(removeBlocker('8.3', '8.5', [], { ...running, state: 'failed' })).toBeNull()
  })

  it('no deja quitar la versión por defecto', () => {
    expect(removeBlocker('8.5', '8.5', [], null)).toContain('default')
  })

  it('no deja quitar una versión con sitios aislados y los nombra', () => {
    const reason = removeBlocker('8.3', '8.5', ['blog', 'api'], null)
    expect(reason).toContain('blog, api')
  })

  it('no deja quitar una versión con un trabajo en curso', () => {
    expect(removeBlocker('8.3', '8.5', [], running)).toContain('job is running')
  })
})
