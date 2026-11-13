/**
 * API del correo integrado para el proceso principal: servidor SMTP, almacén,
 * adjuntos y el bloque `.env` de los proyectos.
 */

import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { app, dialog, shell } from 'electron'
import nodemailer from 'nodemailer'
import {
  MAIL_HOST, MAIL_PORT, inboxFor, mailEnvBlock,
  type MailDetail, type MailEnvResult, type MailEvent, type MailInfo, type MailSummary
} from '../../shared/mail'
import { applyEnvChanges, envValue, parseEnv } from '../../shared/site-files'
import { listSites } from '../valet'
import { catcherState, startCatcher, stopCatcher } from './server'
import {
  clearMessages, deleteMessage, inboxCounts, listMessages, mailRoot, readAttachment, readMessage
} from './store'

const BACKUP_ROOT = join(homedir(), '.valet-studio', 'backups')

let emit: (event: MailEvent) => void = () => {}

function changed(): void {
  emit({ type: 'changed' })
}

/** Arranca el catcher al abrir la aplicación. */
export async function initMail(send: (event: MailEvent) => void): Promise<void> {
  emit = send
  await startCatcher((summary) => emit({ type: 'message', summary }))
}

export function shutdownMail(): Promise<void> {
  return stopCatcher()
}

/** Puerto real del catcher; 2525 como valor inicial si aún no escucha. */
export function smtpPort(): number {
  const current = catcherState()
  return current.running ? current.port : MAIL_PORT
}

/** Puerto obligatorio para operaciones que entregan correo al catcher. */
function activePort(): number {
  const current = catcherState()
  if (!current.running) {
    throw new Error(current.error || 'The built-in mail catcher is not listening')
  }
  return current.port
}

export async function info(): Promise<MailInfo> {  const state = catcherState()
  const [messages, inboxes] = await Promise.all([listMessages(), inboxCounts()])
  await mkdir(mailRoot(), { recursive: true, mode: 0o700 }).catch(() => '')
  return {
    running: state.running,
    host: MAIL_HOST,
    port: state.port,
    compatPort: state.compatPort,
    messages: messages.length,
    inboxes,
    dataDir: mailRoot(),
    error: state.error
  }
}

export async function list(inbox?: string): Promise<MailSummary[]> {
  return listMessages(typeof inbox === 'string' && inbox.trim() ? inbox : undefined)
}

export async function get(id: string): Promise<MailDetail> {
  return readMessage(id)
}

export async function remove(id: string): Promise<void> {
  await deleteMessage(id)
  changed()
}

export async function clear(inbox?: string): Promise<void> {
  await clearMessages(typeof inbox === 'string' && inbox.trim() ? inbox : undefined)
  changed()
}

export async function saveAttachment(id: string, index: number): Promise<string | null> {
  const attachment = await readAttachment(id, index)
  const result = await dialog.showSaveDialog({
    title: 'Save attachment',
    defaultPath: join(app.getPath('downloads'), attachment.filename),
    buttonLabel: 'Save'
  })
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, attachment.content)
  return result.filePath
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Escribe el bloque SMTP del catcher en el `.env` del sitio. */
export async function configureEnv(siteName: string): Promise<MailEnvResult> {
  if (typeof siteName !== 'string' || !siteName.trim()) throw new Error('Choose a site')
  const sites = await listSites()
  const site = sites.find((s) => s.name === siteName)
  if (!site) throw new Error(`Unknown site: ${siteName}`)

  const file = join(site.path, '.env')
  const original = existsSync(file)
    ? await readFile(file, 'utf8')
    : await readFile(join(site.path, '.env.example'), 'utf8').catch(() => {
        throw new Error(`Neither .env nor .env.example exists in ${site.path}`)
      })

  const appName = envValue(parseEnv(original), 'APP_NAME').trim() || site.name
  const username = inboxFor(appName)
  const block = mailEnvBlock(username, activePort())
  const changes: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const eq = line.indexOf('=')
    changes[line.slice(0, eq)] = line.slice(eq + 1).replace(/^"(.*)"$/, '$1')
  }
  // Laravel 10 sigue leyendo MAIL_ENCRYPTION: se deja en `null` para que no
  // intente TLS contra un catcher que habla SMTP claro.
  changes.MAIL_ENCRYPTION = 'null'

  const before = parseEnv(original)
  const values = Object.fromEntries(before.map((e) => [e.key, e.value]))
  const next = applyEnvChanges(original, Object.entries(changes).map(([key, value]) => ({ key, value })))
  const changedKeys = Object.keys(changes).filter((key) => (values[key] ?? null) !== changes[key])

  if (existsSync(file)) {
    const dir = join(BACKUP_ROOT, stamp(), 'env')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const backup = join(dir, `${basename(site.path)}-env`)
    await copyFile(file, backup)
    await chmod(backup, 0o600)
  }
  await writeFile(file, next, { mode: 0o600 })
  await chmod(file, 0o600)
  return { site: site.name, file, changed: changedKeys, env: block }
}

/** Envía un mensaje de prueba con el usuario SMTP como bandeja. */
export async function sendTest(to: string, inbox: string): Promise<void> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Invalid email address')
  const name = inboxFor(inbox)
  const transport = nodemailer.createTransport({
    host: MAIL_HOST,
    port: activePort(),
    secure: false,
    ignoreTLS: true,
    auth: { user: name, pass: 'valetdeck' }
  })
  await transport.sendMail({
    from: 'Valet Deck <mail@valetdeck.local>',
    to,
    subject: 'Valet Deck mail test',
    text: `If you can read this, the built-in mail catcher is working.\nInbox: ${name}\n`
  })
  transport.close()

  // El evento de llegada puede adelantar al retorno del envío: se confirma que
  // el mensaje está en disco antes de dar el test por bueno.
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const messages = await listMessages(name)
    if (messages.some((m) => m.subject === 'Valet Deck mail test')) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('The message was accepted, but it did not appear in the inbox.')
}

export async function openData(): Promise<void> {
  await mkdir(mailRoot(), { recursive: true, mode: 0o700 })
  const error = await shell.openPath(mailRoot())
  if (error) throw new Error(error)
}

export type { MailEvent, MailInfo, MailSummary }
