// Estado de los componentes que muestra la ventana de primer arranque. Es puro:
// recibe el diagnóstico del instalador y devuelve qué falta y qué es opcional.
import { NODE_VERSION } from './stack'
import type { Env } from './types'

export type SetupComponentId = 'php' | 'composer' | 'nginx' | 'valet' | 'node' | 'mariadb'

export interface SetupComponent {
  id: SetupComponentId
  label: string
  detail: string
  installed: boolean
  required: boolean
}

const hasPhp = (env: Env): boolean =>
  env.php.target
    ? env.php.installed && env.php.current === env.php.target
    : env.php.installed

const hasComposer = (env: Env): boolean => env.tools.composer === true

const hasNginx = (env: Env): boolean => env.tools.nginx === true

const hasValet = (env: Env): boolean => env.valet.installed

const hasNode = (env: Env): boolean =>
  env.node.installed && env.node.version.startsWith(`${NODE_VERSION}.`)

const hasMariaDb = (env: Env): boolean => env.mariadb.active

const canInstallNode = (env: Env): boolean => Boolean(env.node.nvm || env.tools.git || env.pm)

/** Componentes que el setup puede instalar, con su estado actual. */
export function setupComponents(env: Env): SetupComponent[] {
  return [
    {
      id: 'php',
      label: env.php.target ? `PHP ${env.php.target}` : 'PHP',
      detail: hasPhp(env)
        ? `Runtime and PHP-FPM · ${env.php.managed || env.php.current}`
        : 'Runtime, PHP-FPM and Valet extensions',
      installed: hasPhp(env),
      required: true
    },
    {
      id: 'composer',
      label: 'Composer',
      detail: 'Dependency manager for PHP',
      installed: hasComposer(env),
      required: true
    },
    {
      id: 'nginx',
      label: 'nginx',
      detail: 'Web server for your sites',
      installed: hasNginx(env),
      required: true
    },
    {
      id: 'valet',
      label: 'Laravel Valet',
      detail: hasValet(env)
        ? env.valet.version
          ? `.test router · v${env.valet.version}`
          : '.test router · ready'
        : '.test domain router for your projects',
      installed: hasValet(env),
      required: true
    },
    {
      id: 'node',
      label: `Node.js ${NODE_VERSION}`,
      detail: hasNode(env)
        ? `Front-end tooling · v${env.node.version}${env.node.nvm ? ' (nvm)' : ''}`
        : canInstallNode(env)
          ? `Front-end tooling · nvm + Node ${NODE_VERSION}`
          : 'Front-end tooling · nvm not available',
      installed: hasNode(env),
      required: false
    },
    {
      id: 'mariadb',
      label: 'MariaDB',
      detail: hasMariaDb(env)
        ? 'Database server · running'
        : env.mariadb.installed
          ? 'Database server · stopped'
          : 'Database server for your projects',
      installed: hasMariaDb(env),
      required: false
    }
  ]
}

/** ¿Falta algún componente requerido para abrir la app? */
export function setupNeeded(env: Env): boolean {
  return setupComponents(env).some((component) => component.required && !component.installed)
}
