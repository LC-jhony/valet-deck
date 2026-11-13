import { describe, expect, it } from 'vitest'
import { elevationFailure, planElevation } from './elevate'

describe('plan de elevación', () => {
  it('prefiere sudo -A cuando hay askpass: sudo cachea la contraseña y abre una sola ventana', () => {
    expect(planElevation(true, true, '/ruta/askpass')).toEqual({ cmd: '/usr/bin/sudo', prefix: ['-A'] })
  })

  it('usa pkexec cuando no hay askpass, aunque sudo exista', () => {
    expect(planElevation(true, true, null)).toEqual({ cmd: 'pkexec', prefix: [] })
  })

  it('usa pkexec cuando no hay sudo', () => {
    expect(planElevation(true, false, '/ruta/askpass')).toEqual({ cmd: 'pkexec', prefix: [] })
  })

  it('no elige nada si no hay ni sudo con askpass ni pkexec', () => {
    expect(planElevation(false, false, '/ruta/askpass')).toBeNull()
    expect(planElevation(false, true, null)).toBeNull()
  })
})

describe('mensajes de fallo al elevar', () => {
  it('normaliza la cancelación del diálogo de sudo a "Operation cancelled"', () => {
    const e = Object.assign(new Error('sudo: se requiere autentificación, pero no se intentó'), { code: 1 })
    expect(elevationFailure(e).message).toBe('Operation cancelled')
  })

  it('normaliza el cierre de pkexec a "Operation cancelled"', () => {
    const e = Object.assign(new Error('Error executing command as another user: Request dismissed'), { code: 126 })
    expect(elevationFailure(e).message).toBe('Operation cancelled')
  })

  it('avisa cuando la contraseña no es correcta', () => {
    const e = Object.assign(new Error('sudo: 3 incorrect password attempts'), { code: 1 })
    expect(elevationFailure(e).message).toContain('not accepted')
  })

  it('no disfraza un binario ausente como cancelación', () => {
    const e = Object.assign(new Error('pkexec: command not found'), { code: 127 })
    expect(elevationFailure(e).message).toBe('pkexec: command not found')
  })

  it('deja intactos los fallos que no son de autenticación', () => {
    const e = Object.assign(new Error('install: cannot create regular file'), { code: 1 })
    expect(elevationFailure(e)).toBe(e)
  })
})
