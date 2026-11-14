import { describe, expect, it } from 'vitest'
import type { PortUsage } from '../shared/types'
import {
  apacheTransform, cgroupOwner, conflictingPorts, domainFromConfig, nginxTransform, phpUseArgs, portFromAddress,
  siteUrlFor, webPortConflict
} from './valet'

const usage = (port: number, process: string, pid = '', unit = ''): PortUsage => ({ port, process, pid, unit })

describe('URL del sitio', () => {
  it('respeta el esquema y el puerto reales de nginx', () => {
    expect(siteUrlFor('app', 'test', false, 80)).toBe('http://app.test/')
    expect(siteUrlFor('app', 'test', true, 443)).toBe('https://app.test/')
    expect(siteUrlFor('app', 'test', false, 8080)).toBe('http://app.test:8080/')
    expect(siteUrlFor('app', 'test', true, 8443)).toBe('https://app.test:8443/')
  })

  it('rechaza nombres que el parser convierte en usuario@host', () => {
    expect(siteUrlFor('a@b', 'test', false, 80)).toBe('')
  })
})

describe('dominio de Valet', () => {
  it('lee domain y acepta tld como respaldo', () => {
    expect(domainFromConfig({ domain: 'test', paths: [] })).toBe('test')
    expect(domainFromConfig({ tld: 'local', paths: [] })).toBe('local')
    expect(domainFromConfig({ domain: ' dev.test ' })).toBe('dev.test')
  })

  it('devuelve null cuando falta o no es un dominio válido', () => {
    expect(domainFromConfig({ paths: [] })).toBeNull()
    expect(domainFromConfig({ domain: '' })).toBeNull()
    expect(domainFromConfig({ domain: 'a@b' })).toBeNull()
    expect(domainFromConfig({ domain: 'test.' })).toBeNull()
    expect(domainFromConfig(null)).toBeNull()
  })
})

describe('puertos en uso', () => {
  it('ignora los puertos que el propio servicio va a conservar', () => {
    const list = [usage(80, '—'), usage(443, '—'), usage(8080, 'nginx')]
    expect(conflictingPorts(list, [80, 443], [80, 443], /^nginx$/i)).toEqual([])
  })

  it('detecta un puerto nuevo ocupado por otro proceso', () => {
    const list = [usage(80, '—'), usage(8080, 'node', '42')]
    expect(conflictingPorts(list, [8080], [80, 443], /^nginx$/i)).toEqual([usage(8080, 'node', '42')])
  })

  it('no se fía del nombre oculto pero sí del puerto actual del servicio', () => {
    const list = [usage(80, '—')]
    expect(conflictingPorts(list, [80], [80, 443], /^(apache2?|httpd)$/i)).toEqual([])
    expect(conflictingPorts(list, [80], [8080, 8443], /^nginx$/i)).toHaveLength(1)
  })
})

describe('conflicto con otro servidor local', () => {
  const info = (usage: PortUsage[]) => ({
    config: { http: 80, https: 443 },
    usage,
    nginxActive: false,
    apache: { installed: false, active: false, enabled: false, http: null, https: null }
  })

  it('detecta Flock por su unidad y agrupa 80 y 443', () => {
    const conflict = webPortConflict(info([
      usage(80, 'Flock (flock@jhony.service)', '2123', 'flock@jhony.service'),
      usage(443, 'Flock (flock@jhony.service)', '2123', 'flock@jhony.service')
    ]))
    expect(conflict).toEqual({
      unit: 'flock@jhony.service',
      process: 'Flock (flock@jhony.service)',
      ports: [80, 443]
    })
  })

  it('no confunde a nginx con un conflicto', () => {
    expect(webPortConflict(info([
      usage(80, 'nginx', '100', 'nginx.service'),
      usage(443, 'nginx', '100', 'nginx.service')
    ]))).toBeNull()
  })

  it('ignora sockets sin unidad (procesos de usuario o sin cgroup)', () => {
    expect(webPortConflict(info([usage(443, 'node', '42', '')]))).toBeNull()
  })
})

describe('lectura de listen', () => {
  it('extrae el puerto de IPv4, IPv6 y comodín', () => {
    expect(portFromAddress('127.0.0.1:8080')).toBe(8080)
    expect(portFromAddress('[::1]:443')).toBe(443)
    expect(portFromAddress('*:80')).toBe(80)
    expect(portFromAddress('sin-puerto')).toBeNull()
  })

  it('nombra el dueño real de un socket por su cgroup', () => {
    expect(cgroupOwner('/system.slice/system-flock.slice/flock@jhony.service'))
      .toBe('Flock (flock@jhony.service)')
    expect(cgroupOwner('/system.slice/nginx.service')).toBe('nginx')
    expect(cgroupOwner('/system.slice/mariadb.service')).toBe('mariadb')
    expect(cgroupOwner('/user.slice/user-1000.slice/user@1000.service/app.slice/code.scope')).toBeNull()
    expect(cgroupOwner('')).toBeNull()
  })

  it('reescribe solo el puerto de nginx y conserva el resto de la directiva', () => {
    const rewrite = nginxTransform({ 80: 8080, 443: 8443 })
    expect(rewrite('    listen 443 ssl;\n    listen [::]:80;'))
      .toBe('    listen 8443 ssl;\n    listen [::]:8080;')
    expect(rewrite('listen 127.0.0.1:80;')).toBe('listen 127.0.0.1:8080;')
    expect(rewrite('listen 9000;')).toBe('listen 9000;')
  })

  it('reescribe Listen y los VirtualHost de Apache', () => {
    const rewrite = apacheTransform({ 80: 8080, 443: 8443 })
    expect(rewrite('Listen 80\n<VirtualHost *:443>')).toBe('Listen 8080\n<VirtualHost *:8443>')
  })
})

describe('versión de PHP', () => {
  it('usa PHP 8.5 por defecto: Valet 2.4.5 le añade php y -fpm por su cuenta', () => {
    expect(phpUseArgs()).toEqual(['use', '8.5'])
  })

  it('permite restaurar la versión anterior si el cambio falla', () => {
    expect(phpUseArgs('8.4')).toEqual(['use', '8.4'])
  })

  it('rechaza versiones con prefijo o formato raro', () => {
    expect(() => phpUseArgs('php@8.5')).toThrow('Invalid version')
    expect(() => phpUseArgs('8')).toThrow('Invalid version')
    expect(() => phpUseArgs('')).toThrow('Invalid version')
  })
})
