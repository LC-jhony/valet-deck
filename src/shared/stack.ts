/**
 * Una sola versión de cada componente. No hay selector ni lista de versiones:
 * el panel instala, usa y repara siempre esta combinación. Las versiones que ya
 * existan en el equipo no se borran; simplemente dejan de gestionarse aquí.
 */

/** Versión de PHP que instala y activa el panel en sistemas apt. */
export const PHP_VERSION = '8.5'

/** Pasos manuales para que Ubuntu ofrezca PHP 8.5 si el PPA aún no está. */
export const PHP_PPA_COMMANDS = [
  'sudo add-apt-repository ppa:ondrej/php',
  'sudo apt-get update'
]

/** Versión mayor de Node.js que instala el panel con nvm. */
export const NODE_VERSION = '26'

/** Repositorio y etiqueta fijados de nvm. El commit se verifica tras el clon. */
export const NVM_REPO = 'https://github.com/nvm-sh/nvm.git'
export const NVM_TAG = 'v0.40.8'
/** Commit de la etiqueta v0.40.8: si el clon no coincide, se descarta. */
export const NVM_COMMIT = 'a885b885fef16fac4bc544188fb25e9e37ae83e8'

/** Comandos que ejecuta el instalador dentro de una shell con nvm cargado. */
export const nvmNodeCommands = (): string[] => [
  `nvm install ${NODE_VERSION}`,
  `nvm alias default ${NODE_VERSION}`
]

/** Pasos manuales para instalar nvm cuando no está en el sistema. */
export const NVM_SETUP_COMMANDS = [
  'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash',
  '. "$HOME/.nvm/nvm.sh"'
]
