import { describe, expect, it } from 'vitest'
import {
  PPA_SERIES, SURY_NEWEST_SUITE, SURY_SERIES, distroProvidesTargetPhp, phpRepoCommands,
  phpRepoFor, phpRepoLabel, ppaRepoCommands, suryInstallSnippet, suryRepoCommands,
  surySourceLine, surySuite, type RepoOsInfo
} from './php-repo'

const os = (patch: Partial<RepoOsInfo> = {}): RepoOsInfo => ({
  ubuntu: true, support: 'supported', codename: 'noble', versionId: '24.04', ...patch
})

describe('repositorio PHP por distro', () => {
  it('usa el PPA de Ondřej en las LTS que publica', () => {
    expect(PPA_SERIES.has('noble')).toBe(true)
    expect(PPA_SERIES.has('jammy')).toBe(true)
    expect(phpRepoFor(os())).toEqual({ kind: 'ppa', suite: 'noble' })
    expect(phpRepoFor(os({ codename: 'jammy', versionId: '22.04' }))).toEqual({ kind: 'ppa', suite: 'jammy' })
  })

  it('usa Sury en las versiones intermedias anteriores a 26.04', () => {
    expect(surySuite(os({ codename: 'plucky', versionId: '25.04' }))).toBe(SURY_NEWEST_SUITE)
    expect(phpRepoFor(os({ codename: 'plucky', versionId: '25.04' }))).toEqual({
      kind: 'sury', suite: 'resolute'
    })
  })

  it('desde Ubuntu 26.04 usa el PHP de la distribución', () => {
    expect(distroProvidesTargetPhp(os({ codename: 'resolute', versionId: '26.04' }))).toBe(true)
    expect(distroProvidesTargetPhp(os({ codename: 'stonking', versionId: '26.10' }))).toBe(true)
    expect(distroProvidesTargetPhp(os({ codename: 'plucky', versionId: '25.04' }))).toBe(false)
    expect(distroProvidesTargetPhp(os({ ubuntu: false, codename: 'bookworm', versionId: '12' }))).toBe(false)
    expect(surySuite(os({ codename: 'stonking', versionId: '26.10' }))).toBeNull()
    expect(phpRepoFor(os({ codename: 'stonking', versionId: '26.10' }))).toEqual({ kind: null, suite: null })
    expect(phpRepoFor(os({ codename: 'resolute', versionId: '26.04' }))).toEqual({ kind: null, suite: null })
  })

  it('respeta una suite de Sury publicada tal cual', () => {
    expect(SURY_SERIES.has('resolute')).toBe(true)
    expect(surySuite(os({ codename: 'noble', versionId: '24.04' }))).toBe('noble')
  })

  it('no inventa repositorio en Debian ni en versiones EOL', () => {
    expect(phpRepoFor(os({ ubuntu: false, codename: 'bookworm', versionId: '12' })))
      .toEqual({ kind: null, suite: null })
    expect(phpRepoFor(os({ support: 'eol', codename: 'groovy', versionId: '20.10' })))
      .toEqual({ kind: null, suite: null })
    expect(surySuite(os({ support: 'eol', codename: 'groovy', versionId: '20.10' }))).toBeNull()
  })

  it('conserva el intento de PPA cuando no hay codename', () => {
    expect(phpRepoFor(os({ codename: '' }))).toEqual({ kind: 'ppa', suite: null })
  })
})

describe('comandos del repositorio PHP', () => {
  it('etiqueta cada repositorio para la interfaz', () => {
    expect(phpRepoLabel('ppa', 'noble')).toBe('Ondřej PPA')
    expect(phpRepoLabel('sury', 'resolute')).toBe('Sury · suite resolute')
    expect(phpRepoLabel(null, null)).toBe('Distribution PHP')
  })

  it('escribe la línea de apt de Sury con la clave firmada', () => {
    expect(surySourceLine('resolute')).toBe(
      'deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ resolute main'
    )
  })

  it('devuelve los comandos manuales del repositorio elegido', () => {
    expect(phpRepoCommands('ppa', 'noble')).toEqual(ppaRepoCommands())
    expect(phpRepoCommands('sury', 'resolute')).toEqual(suryRepoCommands('resolute'))
    expect(phpRepoCommands(null, null)).toEqual([])
    expect(suryRepoCommands('resolute').join('\n')).toContain('sury-php.list')
  })

  it('genera un guion de instalación seguro y valida la suite', () => {
    const snippet = suryInstallSnippet('resolute')
    expect(snippet).toContain("curl -fsSL 'https://packages.sury.org/php/apt.gpg'")
    expect(snippet).toContain(surySourceLine('resolute'))
    expect(snippet).toContain('set -Eeo pipefail')
    expect(() => suryInstallSnippet("x'; rm -rf /")).toThrow('Invalid Sury suite')
    expect(() => suryInstallSnippet('Resolute')).toThrow('Invalid Sury suite')
  })
})
