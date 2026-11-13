// Secciones de la barra de actividad. `settings` no está aquí: se abre desde
// el botón inferior o con Ctrl+, y tiene su propia página.

import type { GlyphName } from './ui-icons'

export type Tab =
  | 'dashboard' | 'sites' | 'php' | 'node' | 'database'
  | 'services' | 'ports' | 'mail' | 'settings'

export type SectionTab = Exclude<Tab, 'settings'>

export interface Section {
  id: SectionTab
  label: string
  icon: GlyphName
  hint: string
}

export const SECTIONS: Section[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: 'panel',
    hint: 'Everything Valet Deck manages on this machine, with the state of each service.'
  },
  {
    id: 'sites',
    label: 'Sites',
    icon: 'sites',
    hint: 'Folders served by Valet. Open a site for its versions, database, mail, queues and logs.'
  },
  {
    id: 'php',
    label: 'PHP',
    icon: 'php',
    hint: 'Installed PHP versions, the one Valet serves by default and the sites isolated on each.'
  },
  {
    id: 'node',
    label: 'Node.js',
    icon: 'terminal',
    hint: 'Node versions installed with nvm, the default alias and the sites that pin one.'
  },
  {
    id: 'database',
    label: 'Databases',
    icon: 'database',
    hint: 'MariaDB, MySQL, PostgreSQL and the SQLite files that belong to your sites.'
  },
  {
    id: 'services',
    label: 'Services',
    icon: 'services',
    hint: 'nginx, Apache, dnsmasq, php-fpm, MySQL/MariaDB, Redis and PostgreSQL via systemctl.'
  },
  {
    id: 'ports',
    label: 'Ports',
    icon: 'ports',
    hint: 'Valet (nginx) and Apache ports, with validation and automatic rollback.'
  },
  {
    id: 'mail',
    label: 'Mail',
    icon: 'mail',
    hint: 'Every email your apps send is caught on this machine, split by SMTP username.'
  }
]
