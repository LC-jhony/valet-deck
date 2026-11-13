import { describe, expect, it } from 'vitest'
import {
  NODE_VERSION, NVM_COMMIT, NVM_SETUP_COMMANDS, NVM_TAG, PHP_PPA_COMMANDS, PHP_VERSION, nvmNodeCommands
} from './stack'

describe('versiones únicas', () => {
  it('fija PHP 8.5 y no ofrece más versiones', () => {
    expect(PHP_VERSION).toBe('8.5')
  })

  it('fija Node.js 26 y lo deja como predeterminado de nvm', () => {
    expect(NODE_VERSION).toBe('26')
    expect(nvmNodeCommands()).toEqual(['nvm install 26', 'nvm alias default 26'])
  })

  it('ignora cualquier versión que se cuele como argumento', () => {
    // @ts-expect-error: la función no acepta argumentos; siempre instala 26.
    expect(nvmNodeCommands('22')).toEqual(['nvm install 26', 'nvm alias default 26'])
  })

  it('fija una etiqueta y un commit verificable de nvm', () => {
    expect(NVM_TAG).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(NVM_COMMIT).toMatch(/^[0-9a-f]{40}$/)
  })

  it('da el comando del PPA junto con la actualización de índices', () => {
    expect(PHP_PPA_COMMANDS).toEqual([
      'sudo add-apt-repository ppa:ondrej/php',
      'sudo apt-get update'
    ])
  })

  it('explica cómo instalar nvm cuando falta', () => {
    expect(NVM_SETUP_COMMANDS[0]).toContain('nvm-sh/nvm')
    expect(NVM_SETUP_COMMANDS[1]).toBe('. "$HOME/.nvm/nvm.sh"')
  })
})
