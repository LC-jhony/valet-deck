import { describe, expect, it } from 'vitest'
import { parkDirProblem } from './install'

describe('carpeta de proyectos', () => {
  it('rechaza convertir una rama del sistema en raíz de sitios', () => {
    for (const dir of ['/', '/usr', '/usr/local', '/etc/nginx', '/opt', '/var', '/root', '/boot']) {
      expect(parkDirProblem(dir), dir).toContain('system directory')
    }
  })

  it('permite carpetas normales, incluido /var/www', () => {
    for (const dir of ['/home/jhony/Sites', '/home/jhony', '/var/www', '/opt/sites', '/srv/dev']) {
      expect(parkDirProblem(dir), dir).toBeNull()
    }
  })
})
