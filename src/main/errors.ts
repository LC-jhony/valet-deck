// Traduce la salida cruda de un comando a un mensaje que se pueda leer y actuar.
// Es puro: recibe la firma del fallo y devuelve título, detalle y comandos.
import type { Pm } from './prereqs'
import { nvmNodeCommands, PHP_PPA_COMMANDS } from '../shared/stack'

export interface ClassifiedError {
  title: string
  detail: string
  hint: string
  commands: string[]
}

export interface ErrorInput {
  cmd: string
  args?: string[]
  code?: number | null
  stderr?: string
  killed?: boolean
  message?: string
  pm?: Pm | null
  /** Límite que se agotó, para decirlo en el mensaje. */
  timeoutMs?: number
}

const basename = (p: string): string => p.split('/').pop() ?? p
const KNOWN_PROGRAMS = new Set([
  'apt-get', 'apt', 'dpkg', 'dnf', 'rpm', 'pacman', 'valet', 'composer',
  'add-apt-repository', 'systemctl', 'nginx', 'php', 'npm', 'node', 'git',
  'curl', 'update-alternatives', 'mariadb-install-db'
])

/**
 * Nombre legible del comando real, saltando `sudo`, `env` y sus opciones. Sin
 * esto, un fallo de apt se titula «/usr/bin/sudo failed» y arrastra una línea
 * de 64 paquetes.
 */
export function commandLabel(cmd: string, args: string[] = []): string {
  const all = [cmd, ...args]
  const at = all.findIndex((token) => KNOWN_PROGRAMS.has(basename(token)))
  if (at < 0) return [basename(cmd), ...args].join(' ').slice(0, 120)
  const name = basename(all[at])
  const verb = all.slice(at + 1).find((token) => !token.startsWith('-') && !token.includes('='))
  return verb ? `${name} ${verb}` : name
}

/**
 * Avisos de GTK/Adwaita que emiten zenity y kdialog. No son fallos de la
 * aplicación, pero acaban en el stderr de `sudo -A` y antes se mostraban como
 * el error de la instalación.
 */
const DIALOG_NOISE = /^\s*(?:\(zenity:\d+\)|\(kdialog:\d+\)|Gtk-|Gdk-|Adw-)|AdwMessageDialog/i

/** Quita el ruido de los diálogos nativos de la salida de un comando. */
export function cleanDialogNoise(text: string): string {
  return text
    .split('\n')
    .filter((line) => !DIALOG_NOISE.test(line))
    .join('\n')
    .trim()
}

const tail = (text: string, lines = 3): string => {
  const parts = text.trim().split('\n').filter(Boolean)
  return parts.slice(-lines).join('\n')
}

const updateCommand = (pm: Pm | null): string[] => {
  if (pm === 'apt') return ['sudo apt-get update']
  if (pm === 'dnf') return ['sudo dnf makecache --refresh']
  if (pm === 'pacman') return ['sudo pacman -Sy']
  return []
}

const installCommand = (pm: Pm | null, pkg: string): string[] => {
  if (pm === 'apt') return [`sudo apt-get install -y ${pkg}`]
  if (pm === 'dnf') return [`sudo dnf install -y ${pkg}`]
  if (pm === 'pacman') return [`sudo pacman -S --needed ${pkg}`]
  return []
}

/** Convierte el fallo de un comando en un diagnóstico con salida. */
export function classify(input: ErrorInput): ClassifiedError {
  const stderr = cleanDialogNoise(input.stderr ?? '')
  const out = `${stderr}\n${input.message ?? ''}`
  const label = commandLabel(input.cmd, input.args)
  const fullCommand = [input.cmd, ...(input.args ?? [])].join(' ')
  const generic: ClassifiedError = {
    title: `${label} failed`,
    detail: tail(stderr) || input.message || `The command exited with code ${input.code ?? 'unknown'}.`,
    hint: 'Check the installation log to see the full output.',
    commands: []
  }

  if (input.killed) {
    const lastOutput = tail(stderr.replace(/\r/g, '\n'), 2)
    const minutes = input.timeoutMs ? Math.round(input.timeoutMs / 60_000) : 0
    return {
      title: 'The command did not finish in time',
      detail: [
        `${label} was still running after ${minutes ? `${minutes} minutes` : 'the time limit'} and was stopped.`,
        lastOutput ? `Last output:\n${lastOutput}` : ''
      ].filter(Boolean).join('\n\n'),
      hint: 'A download from the package mirror may be stalled, or another package tool (PackageKit, unattended-upgrades) may be holding the apt lock. Try again; if it repeats, check the commands below and the installation log.',
      commands: input.pm === 'apt'
        ? [
            'ps aux | grep -E "apt|dpkg|packagekitd"',
            'sudo systemctl status packagekit unattended-upgrades --no-pager',
            'sudo tail -n 20 /var/log/apt/term.log'
          ]
        : []
    }
  }

  if (/Could not get lock|dpkg frontend lock|Unable to acquire.*lock/i.test(out)) {
    return {
      title: 'Another package manager is in use',
      detail: 'Another apt, dpkg, dnf or pacman process is working right now.',
      hint: 'Wait for it to finish or close the other tool. Do not delete the lock file blindly.',
      commands: input.pm === 'apt'
        ? ['ps aux | grep -E "apt|dpkg|packagekitd"', 'sudo systemctl status packagekit unattended-upgrades --no-pager']
        : ['ps aux | grep -E "dnf|rpm|pacman"']
    }
  }

  if (/No space left on device|No hay espacio/i.test(out)) {
    return {
      title: 'Disk full',
      detail: 'There is no space left to download or write the packages.',
      hint: 'Free up space and press Repair installation again.',
      commands: ['df -h /', 'du -sh ~/.cache/* 2>/dev/null | sort -h | tail -10']
    }
  }

  if (/Temporary failure resolving|Could not resolve|Name or service not known|Network is unreachable/i.test(out)) {
    return {
      title: 'No network or broken DNS',
      detail: 'The package manager cannot resolve the repository.',
      hint: 'Check the connection before retrying. The panel\'s Hosts mode does not fix internet access.',
      commands: ['ping -c 1 1.1.1.1', ...updateCommand(input.pm ?? null)]
    }
  }

  if (/Failed to fetch|Could not connect|Connection timed out|Timeout was reached|Operation timed out|Error reading from server|Hash Sum mismatch/i.test(out)) {
    return {
      title: 'The package download failed',
      detail: tail(stderr.replace(/\r/g, '\n'), 3),
      hint: 'The mirror stopped responding or the connection was interrupted. Try again: apt reuses the packages it has already downloaded.',
      commands: ['ping -c 1 1.1.1.1', ...updateCommand(input.pm ?? null)]
    }
  }

  if (/(?:nvm install|nvm alias|nvm\.sh)/.test(fullCommand)) {
    return {
      title: 'Node.js could not be installed with nvm',
      detail: tail(stderr) || 'nvm did not finish the installation.',
      hint: 'Check the connection and run the nvm commands in a terminal.',
      commands: nvmNodeCommands()
    }
  }

  const locate = out.match(/Unable to locate package (\S+)/i)
  if (locate) {
    return {
      title: `Package ${locate[1]} is not available`,
      detail: 'The indexes are out of date or the package does not exist in the configured repositories.',
      hint: 'Update the indexes and check the package name for your distribution.',
      commands: [...updateCommand(input.pm ?? null), ...installCommand(input.pm ?? null, locate[1])]
    }
  }

  // Valet (cli/Valet/PackageManagers/Apt.php) lanza este mensaje cuando apt
  // rechaza una dependencia, por ejemplo php8.5-fpm: sin esta regla el fallo
  // llegaba como un «valet failed» sin pistas.
  const aptRefused = out.match(/Apt was unable to install \[([^\]]+)\]/i)
  if (aptRefused) {
    const packages = aptRefused[1].split(/[\s,]+/).filter(Boolean)
    const php = packages.map((p) => p.match(/^php(\d+\.\d+)-fpm$/)?.[1]).find(Boolean)
    return {
      title: `Could not install ${packages.join(', ')}`,
      detail: tail(stderr) || 'Valet asked apt to install a package and apt refused.',
      hint: php
        ? `PHP ${php}-FPM is not in the configured repositories. Add the Ondrej PPA, update the indexes and install it by hand; then run the installation again.`
        : 'Update the indexes and install the package by hand; then run the installation again.',
      commands: php
        ? [...PHP_PPA_COMMANDS, `sudo apt-get install -y ${packages.join(' ')}`]
        : [...updateCommand(input.pm ?? null), ...packages.flatMap((p) => installCommand(input.pm ?? null, p))]
    }
  }

  if (/Transaction check error|conflicting requests|file .* conflicts between attempted installs/i.test(out)) {
    return {
      title: 'Package conflict',
      detail: tail(stderr),
      hint: 'Resolve the conflict with the package manager and try again.',
      commands: input.pm === 'dnf' ? ['sudo dnf check', 'sudo dnf repoquery --duplicates'] : []
    }
  }

  if (/target not found/i.test(out)) {
    return {
      title: 'Package not available in pacman',
      detail: tail(stderr),
      hint: 'Update the indexes or install the equivalent name for Arch.',
      commands: ['sudo pacman -Sy']
    }
  }

  // Antes que 126/127: `sh` devuelve 127 también cuando el binario no existe.
  if (/No such file or directory|command not found/i.test(out)) {
    return {
      title: `${input.cmd} was not found`,
      detail: tail(stderr),
      hint: 'A binary the installer expected is missing. Check the prerequisites guide.',
      commands: []
    }
  }

  if (input.code === 126 || input.code === 127) {
    return {
      title: 'Authentication cancelled',
      detail: 'The administrator dialog was closed without typing the password.',
      hint: 'Try again and authenticate when the system window appears.',
      commands: []
    }
  }

  return generic
}
