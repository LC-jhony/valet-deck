// Guías de instalación y conexión para cada motor de base de datos.
//
// Son texto puro: la interfaz las muestra con su botón de copiar y nunca las
// ejecuta sola. Los comandos usan los nombres reales de los paquetes en apt
// (Ubuntu/Debian), dnf (Fedora) y pacman (Arch), y el bloque `.env` usa los
// datos del servidor que el panel ya conoce. La contraseña del usuario
// gestionado no se incluye nunca: se escribe a mano o se deja que Laravel la
// reciba del archivo que el panel guarda con permisos 0600.

import type { DatabaseEngine } from './site'

export type GuidePm = 'apt' | 'dnf' | 'pacman'

export interface GuideStep {
  label: string
  commands: string[]
}

export interface DatabaseGuide {
  engine: DatabaseEngine
  title: string
  summary: string
  /** Unidad systemd del servidor; `null` en SQLite. */
  service: string | null
  steps: Record<GuidePm, GuideStep[]>
  notes: string[]
}

const MYSQL_CREATE = (client: string): GuideStep => ({
  label: 'Create a database and a user',
  commands: [
    `${client} -e "CREATE DATABASE IF NOT EXISTS my_app;"`,
    `${client} -e "CREATE USER IF NOT EXISTS 'valet_studio'@'localhost' IDENTIFIED BY 'change-me';"`,
    `${client} -e "CREATE USER IF NOT EXISTS 'valet_studio'@'127.0.0.1' IDENTIFIED BY 'change-me';"`,
    `${client} -e "GRANT ALL PRIVILEGES ON my_app.* TO 'valet_studio'@'localhost';"`,
    `${client} -e "GRANT ALL PRIVILEGES ON my_app.* TO 'valet_studio'@'127.0.0.1';"`,
    `${client} -e "FLUSH PRIVILEGES;"`
  ]
})

const POSTGRES_CREATE: GuideStep = {
  label: 'Create a database and a user',
  commands: [
    `sudo -u postgres psql -c "CREATE USER valet_studio WITH PASSWORD 'change-me';"`,
    'sudo -u postgres createdb -O valet_studio my_app'
  ]
}

const mariadb: DatabaseGuide = {
  engine: 'mariadb',
  title: 'MariaDB',
  summary: 'The default database in Valet Deck. It is fast, works with Laravel out of the box and stores its data in /var/lib/mysql.',
  service: 'mariadb',
  steps: {
    apt: [
      {
        label: 'Install the server and client',
        commands: ['sudo apt-get update', 'sudo apt-get install -y mariadb-server mariadb-client']
      },
      { label: 'Start it now and on boot', commands: ['sudo systemctl enable --now mariadb'] },
      MYSQL_CREATE('sudo mariadb'),
      { label: 'Check the version', commands: ['sudo mariadb -e "SELECT VERSION();"'] }
    ],
    dnf: [
      { label: 'Install the server and client', commands: ['sudo dnf install -y mariadb-server'] },
      { label: 'Start it now and on boot', commands: ['sudo systemctl enable --now mariadb'] },
      MYSQL_CREATE('sudo mariadb'),
      { label: 'Check the version', commands: ['sudo mariadb -e "SELECT VERSION();"'] }
    ],
    pacman: [
      { label: 'Install the server and client', commands: ['sudo pacman -S --needed mariadb'] },
      {
        label: 'Initialise the data directory (only once)',
        commands: ['sudo mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql']
      },
      { label: 'Start it now and on boot', commands: ['sudo systemctl enable --now mariadb'] },
      MYSQL_CREATE('sudo mariadb'),
      { label: 'Check the version', commands: ['sudo mariadb -e "SELECT VERSION();"'] }
    ]
  },
  notes: [
    'After installing, open Services and start MariaDB if the panel still shows it stopped.',
    'The panel prepares a managed valet_studio user and stores its password in ~/.valet-studio/mariadb.json with mode 0600. The database card uses it automatically.',
    'The secure installation (anonymous users, the test database and remote root) stays manual: open it from the MariaDB security card once the server runs.'
  ]
}

const mysql: DatabaseGuide = {
  engine: 'mysql',
  title: 'MySQL',
  summary: 'Oracle MySQL. Use it when a project needs a specific MySQL version; MariaDB is the drop-in default for most Laravel apps.',
  service: 'mysql',
  steps: {
    apt: [
      { label: 'Install the server and client', commands: ['sudo apt-get update', 'sudo apt-get install -y mysql-server'] },
      { label: 'Start it now and on boot', commands: ['sudo systemctl enable --now mysql'] },
      { label: 'Harden the installation (optional)', commands: ['sudo mysql_secure_installation'] },
      MYSQL_CREATE('sudo mysql'),
      { label: 'Check the version', commands: ['sudo mysql -e "SELECT VERSION();"'] }
    ],
    dnf: [
      { label: 'Install the community server', commands: ['sudo dnf install -y community-mysql-server'] },
      { label: 'Start it now and on boot', commands: ['sudo systemctl enable --now mysqld'] },
      { label: 'Check the version', commands: ['sudo mysql -e "SELECT VERSION();"'] }
    ],
    pacman: [
      { label: 'Install the server and client', commands: ['sudo pacman -S --needed mysql'] },
      {
        label: 'Initialise the data directory (only once)',
        commands: ['sudo mysqld --initialize --user=mysql --basedir=/usr --datadir=/var/lib/mysql']
      },
      { label: 'Start it now and on boot', commands: ['sudo systemctl enable --now mysqld'] },
      { label: 'Check the version', commands: ['sudo mysql -e "SELECT VERSION();"'] }
    ]
  },
  notes: [
    'MySQL and MariaDB share port 3306. Run only one of them unless you change the port.',
    'On Arch, the service unit is mysqld, not mysql. On Ubuntu and Fedora it is mysql or mariadb depending on the package.',
    'The panel can save separate credentials for MySQL; they are only used from the main process and never returned to the window.'
  ]
}

const postgres: DatabaseGuide = {
  engine: 'postgres',
  title: 'PostgreSQL',
  summary: 'A stricter SQL engine with richer types and queries. Laravel uses the pgsql driver, so PHP also needs the pdo_pgsql extension.',
  service: 'postgresql',
  steps: {
    apt: [
      {
        label: 'Install the server and the PHP driver',
        commands: [
          'sudo apt-get update',
          'sudo apt-get install -y postgresql postgresql-contrib php8.5-pgsql',
          'sudo phpenmod pdo_pgsql'
        ]
      },
      { label: 'Start it now and on boot', commands: ['sudo systemctl enable --now postgresql'] },
      POSTGRES_CREATE,
      { label: 'Check the version', commands: ['sudo -u postgres psql -c "SELECT version();"'] }
    ],
    dnf: [
      {
        label: 'Install the server and the PHP driver',
        commands: [
          'sudo dnf install -y postgresql-server postgresql-contrib php-pgsql',
          'sudo postgresql-setup --initdb'
        ]
      },
      { label: 'Start it now and on boot', commands: ['sudo systemctl enable --now postgresql'] },
      POSTGRES_CREATE,
      { label: 'Check the version', commands: ['sudo -u postgres psql -c "SELECT version();"'] }
    ],
    pacman: [
      { label: 'Install the server and the PHP driver', commands: ['sudo pacman -S --needed postgresql php-pgsql'] },
      {
        label: 'Initialise the data directory (only once)',
        commands: ['sudo -u postgres initdb -D /var/lib/postgres/data']
      },
      { label: 'Start it now and on boot', commands: ['sudo systemctl enable --now postgresql'] },
      POSTGRES_CREATE,
      { label: 'Check the version', commands: ['sudo -u postgres psql -c "SELECT version();"'] }
    ]
  },
  notes: [
    'PHP must load pdo_pgsql. Restart PHP-FPM after installing the driver: sudo systemctl restart php8.5-fpm.',
    'On a fresh Debian or Ubuntu install, local connections use peer authentication. Set a password for valet_studio and use 127.0.0.1 in .env so Laravel connects over TCP.',
    'The panel detects PostgreSQL on 127.0.0.1:5432 and can create and drop databases with the credentials you save.'
  ]
}

const sqlite: DatabaseGuide = {
  engine: 'sqlite',
  title: 'SQLite',
  summary: 'A single file per project. There is no server to start; Laravel creates and migrates the file itself.',
  service: null,
  steps: {
    apt: [{ label: 'Install the PHP driver', commands: ['sudo apt-get install -y php8.5-sqlite3'] }],
    dnf: [{ label: 'Install the PHP driver', commands: ['sudo dnf install -y php-sqlite3'] }],
    pacman: [{ label: 'Install the PHP driver', commands: ['sudo pacman -S --needed php-sqlite'] }]
  },
  notes: [
    'The database is a file, usually database/database.sqlite inside the project.',
    'Create it with touch database/database.sqlite and run php artisan migrate; no user, password or port is needed.',
    'Back it up by copying the file. The panel only lists SQLite files; it never edits them.'
  ]
}

export const DATABASE_GUIDES: Record<DatabaseEngine, DatabaseGuide> = {
  mariadb, mysql, postgres, sqlite
}

export function databaseGuide(engine: DatabaseEngine): DatabaseGuide {
  return DATABASE_GUIDES[engine]
}

/**
 * Líneas para el `.env` de Laravel. Usa los datos reales del servidor que
 * conoce la interfaz (host, puerto y usuario) y deja la contraseña como
 * marcador: la real nunca viaja al renderer.
 */
export function databaseEnv(
  engine: DatabaseEngine,
  server: { host: string; port: number; username: string } | null,
  database = 'my_app'
): string[] {
  if (engine === 'sqlite') {
    return [
      'DB_CONNECTION=sqlite',
      `DB_DATABASE=/absolute/path/to/${database}.sqlite`
    ]
  }
  const host = server?.host || '127.0.0.1'
  const port = server?.port || (engine === 'postgres' ? 5432 : 3306)
  const user = server?.username || (engine === 'postgres' ? 'postgres' : 'root')
  return [
    `DB_CONNECTION=${engine === 'postgres' ? 'pgsql' : 'mysql'}`,
    `DB_HOST=${host}`,
    `DB_PORT=${port}`,
    `DB_DATABASE=${database}`,
    `DB_USERNAME=${user}`,
    'DB_PASSWORD=change-me'
  ]
}
