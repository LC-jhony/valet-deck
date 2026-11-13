/**
 * Contrato del correo integrado. El panel trae su propio servidor SMTP de
 * recepción: ninguna aplicación entrega correo a un servidor externo, todo se
 * guarda como `.eml` bajo `~/.valet-studio/mail`.
 */

import { inboxName } from './site-files'

/** Dirección del servidor SMTP embebido. Solo escucha en loopback. */
export const MAIL_HOST = '127.0.0.1'
/** Puerto recomendado en los `.env` de los proyectos. */
export const MAIL_PORT = 2525
/** Puerto antiguo que usaban los `.env` anteriores: se escucha si está libre. */
export const MAIL_COMPAT_PORT = 1025
/** Tamaño máximo de un mensaje, adjuntos incluidos (25 MB como Flock). */
export const MAIL_MAX_BYTES = 25 * 1024 * 1024
/** Bandeja de los mensajes que llegan sin usuario SMTP. */
export const MAIL_DEFAULT_INBOX = 'default'

export interface MailInbox {
  name: string
  count: number
}

export interface MailSummary {
  id: string
  inbox: string
  from: string
  to: string
  subject: string
  /** ISO 8601. */
  date: string
  size: number
  attachments: number
  preview: string
}

export interface MailAttachment {
  /** Posición en el mensaje; se usa para guardarla. */
  index: number
  filename: string
  contentType: string
  size: number
}

export interface MailHeader {
  key: string
  value: string
}

export interface MailDetail extends MailSummary {
  cc: string
  bcc: string
  replyTo: string
  messageId: string
  html: string
  text: string
  raw: string
  headers: MailHeader[]
  attachmentList: MailAttachment[]
}

export interface MailInfo {
  running: boolean
  host: string
  port: number
  /** Puerto de compatibilidad (1025) si estaba libre; `null` si no. */
  compatPort: number | null
  messages: number
  inboxes: MailInbox[]
  /** Carpeta donde viven los `.eml`. */
  dataDir: string
  /** Último error del servidor, vacío mientras todo va bien. */
  error: string
}

export interface MailEnvResult {
  site: string
  file: string
  changed: string[]
  /** Bloque que quedó escrito, listo para mostrar. */
  env: string
}

export type MailEvent =
  | { type: 'message'; summary: MailSummary }
  | { type: 'changed' }

/** Bandeja que corresponde a un usuario SMTP. Igual que Flock: sin usuario o `null` → `default`. */
export function inboxFor(username: string | null | undefined): string {
  const raw = (username ?? '').trim()
  if (!raw || raw.toLowerCase() === 'null') return MAIL_DEFAULT_INBOX
  return inboxName(raw) || MAIL_DEFAULT_INBOX
}

/** Líneas que un proyecto Laravel necesita para enviar el correo al catcher. */
export function mailEnvBlock(username: string, port = MAIL_PORT, host = MAIL_HOST): string {
  const user = username.trim() || 'null'
  return [
    'MAIL_MAILER=smtp',
    `MAIL_HOST=${host}`,
    `MAIL_PORT=${port}`,
    `MAIL_USERNAME="${user.replace(/"/g, '\\"')}"`,
    'MAIL_PASSWORD=null',
    'MAIL_SCHEME=null'
  ].join('\n')
}

export interface MailApi {
  info(): Promise<MailInfo>
  /** Mensajes, del más nuevo al más antiguo. Sin bandeja, todos. */
  list(inbox?: string): Promise<MailSummary[]>
  get(id: string): Promise<MailDetail>
  remove(id: string): Promise<void>
  /** Vacía una bandeja; sin argumento, todas. */
  clear(inbox?: string): Promise<void>
  /** Abre el diálogo de guardado y devuelve la ruta, o `null` si se cancela. */
  saveAttachment(id: string, index: number): Promise<string | null>
  /** Escribe el bloque SMTP en el `.env` de un sitio. */
  configureEnv(site: string): Promise<MailEnvResult>
  /** Envía un mensaje de prueba a la bandeja indicada. */
  sendTest(to: string, inbox: string): Promise<void>
  openData(): Promise<void>
  onEvent(cb: (e: MailEvent) => void): () => void
}
