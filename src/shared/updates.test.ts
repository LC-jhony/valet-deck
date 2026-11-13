import { describe, expect, it } from 'vitest'
import type { UpdateItem } from './types'
import { canUpgrade } from './updates'

const item = (patch: Partial<UpdateItem>): UpdateItem => ({
  id: 'valet',
  label: 'valet',
  current: '2.4.5',
  latest: 'v2.4.5',
  available: false,
  source: 'composer',
  packages: ['cpriego/valet-linux'],
  blocked: '',
  needsElevation: false,
  commands: [],
  ...patch
})

describe('botón de actualizar', () => {
  it('no ofrece actualizar valet cuando ya está en la última versión', () => {
    expect(canUpgrade(item({}))).toBe(false)
  })

  it('lo ofrece en cuanto hay una versión nueva', () => {
    expect(canUpgrade(item({ latest: 'v2.4.6', available: true }))).toBe(true)
  })

  it('no lo ofrece si el panel no puede actualizar el programa', () => {
    expect(canUpgrade(item({ available: true, blocked: 'Installed outside the panel.' }))).toBe(false)
  })
})
