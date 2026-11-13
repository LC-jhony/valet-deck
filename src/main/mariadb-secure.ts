// Abre `sudo mariadb-secure-installation` (o `mysql_secure_installation` en
// MariaDB 10.3, que es la de Ubuntu 20.04/20.10) en una ventana de terminal del
// sistema. El asistente es interactivo (contraseña de sudo y preguntas sobre
// la configuración segura), así que no puede correr en el registro del panel:
// la ventana externa lo muestra todo y queda abierta al terminar.

import { spawn } from 'node:child_process'
import { run } from './exec'
import { elevationCommand } from './elevate'
import { which } from './laravel-installer'
import { findMariaDbClient } from './mariadb-setup'

/**
 * Nombres del asistente seguro, de más nuevo a más antiguo. MariaDB 10.3 (la de
 * Ubuntu 20.04 y 20.10) solo trae `mysql_secure_installation`; el nombre
 * `mariadb-secure-installation` llegó con 10.4.6.
 */
export const SECURE_COMMANDS = ['mariadb-secure-installation', 'mysql_secure_installation'] as const

/** Primer asistente disponible según `available`; `null` si no hay ninguno. */
export function pickSecureCommand(available: readonly string[]): string | null {
  return SECURE_COMMANDS.find((name) => available.includes(name)) ?? null
}

/**
 * Terminales que se buscan, en orden, con la forma de pasarles el comando.
 * `--` separa las opciones del terminal del comando (ptyxis, gnome-terminal);
 * `-e` toma el comando como argumentos (familia xterm); `-x` (xfce4-terminal)
 * ejecuta el resto de la línea en lugar de un único string.
 *
 * `x-terminal-emulator` va al final: es el enlace de alternativas de Debian y
 * puede apuntar a cualquiera de los anteriores (ptyxis en Ubuntu 24.10+, por
 * ejemplo, que no entiende `-e`). Solo sirve como último recurso cuando el
 * destino es de la familia xterm, que sí lo acepta.
 */
export const TERMINALS: ReadonlyArray<readonly [name: string, flag: string]> = [
  ['ptyxis', '--'],
  ['gnome-terminal', '--'],
  ['konsole', '-e'],
  ['xfce4-terminal', '-x'],
  ['mate-terminal', '-e'],
  ['tilix', '-e'],
  ['xterm', '-e'],
  ['x-terminal-emulator', '-e']
]

/**
 * Comillas para el script que se pasa a `sh -c`. Los nombres de terminal y los
 * comandos de elevación son rutas normales, pero se citan igualmente.
 */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Asistente seguro más una pausa final: sin ella la ventana se cierra sola al
 * terminar y el resultado no se puede leer. El código de salida queda visible.
 *
 * Con `sudo -A` se quita `-A`: la terminal ya tiene TTY y sudo puede preguntar
 * ahí. Sin ese detalle, sudo intentaría usar el diálogo gráfico de askpass.
 */
export function buildSecureScript(
  elevation: { cmd: string; args: string[] } | null,
  secureCommand: string = SECURE_COMMANDS[0]
): string {
  const command = elevation
    ? [
        elevation.cmd,
        ...(elevation.cmd.endsWith('/sudo')
          ? elevation.args.filter((arg) => arg !== '-A')
          : elevation.args),
        secureCommand
      ].map(shellQuote).join(' ')
    : secureCommand
  return [
    command,
    'code=$?',
    'echo',
    'echo "The assistant finished with code $code. Press Enter to close this window."',
    'read _'
  ].join('; ')
}

/** Guion de reserva cuando no se conoce la elevación (pruebas y último recurso). */
export const SECURE_SCRIPT = buildSecureScript({ cmd: 'sudo', args: [] })

export interface SecureTerminalPlan {
  bin: string
  args: string[]
}

/**
 * Elige la primera terminal disponible y compone el comando. Pura: la lista de
 * terminales presentes viene de fuera, para poder probarla sin sistema.
 */
export function planSecureTerminal(available: string[], script: string = SECURE_SCRIPT): SecureTerminalPlan | null {
  for (const [name, flag] of TERMINALS) {
    if (!available.includes(name)) continue
    return { bin: name, args: [flag, 'sh', '-c', script] }
  }
  return null
}

/**
 * Abre el asistente seguro de MariaDB en una terminal visible y devuelve cuál
 * se usó. No espera a que termine: algunos terminales (gnome-terminal) salen en
 * cuanto delegan la ventana a su proceso servidor, y el usuario ve el asistente
 * de todos modos.
 */
export async function openSecureInstallation(): Promise<string> {
  // El cliente se llama `mariadb` o `mysql` según la versión; basta con uno.
  if (!(await findMariaDbClient())) {
    throw new Error('MariaDB is not installed. Install it from the Installation tab.')
  }
  const secureAvailable: string[] = []
  for (const name of SECURE_COMMANDS) {
    if (await which(name)) secureAvailable.push(name)
  }
  const secureCommand = pickSecureCommand(secureAvailable)
  if (!secureCommand) {
    throw new Error('The MariaDB security assistant was not found. Reinstall the mariadb-server package.')
  }
  if ((await run('systemctl', ['is-active', 'mariadb'], true)).trim() !== 'active') {
    throw new Error('MariaDB is not running. Start the service from the Services tab first.')
  }
  const available: string[] = []
  for (const [name] of TERMINALS) {
    if (await which(name)) available.push(name)
  }
  const elevation = await elevationCommand()
  if (!elevation) {
    throw new Error('No elevation method: install polkit (pkexec) or sudo with zenity')
  }
  const plan = planSecureTerminal(available, buildSecureScript(elevation, secureCommand))
  if (!plan) {
    throw new Error('No terminal emulator was found. Install one, for example: sudo apt install gnome-terminal')
  }
  const child = spawn(plan.bin, plan.args, { detached: true, stdio: 'ignore' })
  // Sin manejar, un fallo al lanzar (terminal desaparecida entre la detección y
  // el spawn) cerraría el proceso principal; el usuario verá la ventana no abrirse.
  child.on('error', () => { /* la ventana no llegó a abrirse */ })
  child.unref()
  return plan.bin
}
