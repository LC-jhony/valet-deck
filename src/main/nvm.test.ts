import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NVM_COMMIT, NVM_TAG } from '../shared/stack'
import { nvmAvailable, nvmDir, nvmScript } from './nvm'

const previous = process.env.NVM_DIR

afterEach(() => {
  if (previous === undefined) delete process.env.NVM_DIR
  else process.env.NVM_DIR = previous
})

describe('nvm', () => {
  it('respeta NVM_DIR y compone la ruta de nvm.sh', () => {
    process.env.NVM_DIR = '/tmp/nvm-personalizado'
    expect(nvmDir()).toBe('/tmp/nvm-personalizado')
    expect(nvmScript()).toBe('/tmp/nvm-personalizado/nvm.sh')
  })

  it('detecta nvm.sh y no confunde un directorio vacío', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vd-nvm-'))
    try {
      process.env.NVM_DIR = dir
      expect(nvmAvailable()).toBe(false)
      await writeFile(join(dir, 'nvm.sh'), '')
      expect(nvmAvailable()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fija una etiqueta y un commit verificable', () => {
    expect(NVM_TAG).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(NVM_COMMIT).toMatch(/^[0-9a-f]{40}$/)
  })
})
