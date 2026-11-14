import { describe, expect, it } from 'vitest'
import { chromeNssDb, valetCaPath } from './certs'

describe('almacén NSS de Chrome', () => {
  it('usa la base clásica mientras exista', () => {
    expect(chromeNssDb('/home/ana', true, false)).toBe('/home/ana/.pki/nssdb')
    expect(chromeNssDb('/home/ana', true, true)).toBe('/home/ana/.pki/nssdb')
  })

  it('usa la base nueva cuando solo existe esa', () => {
    expect(chromeNssDb('/home/ana', false, true)).toBe('/home/ana/.local/share/pki/nssdb')
  })

  it('crea la clásica cuando no hay ninguna', () => {
    expect(chromeNssDb('/home/ana', false, false)).toBe('/home/ana/.pki/nssdb')
  })

  it('lee la CA que genera Valet al habilitar HTTPS', () => {
    expect(valetCaPath('/home/ana')).toBe('/home/ana/.valet/CA/LaravelValetCASelfSigned.pem')
  })
})
