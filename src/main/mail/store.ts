/**
 * Almacén de mensajes: un `.eml` por correo dentro de
 * `~/.valet-studio/mail/<bandeja>/`. El nombre del archivo es el id, ordenable
 * de más nuevo a más antiguo. Nada sale del equipo.
 */

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import {
  MAIL_DEFAULT_INBOX, type MailAttachment, type MailDetail, type MailHeader, type MailSummary
} from '../../shared/mail'

const ID_RE = /^\d{10,16}-[0-9a-f]{6}$/
const INBOX_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/

interface CacheEntry {
  key: string
  summary: MailSummary
}

const cache = new Map<string, CacheEntry>()

export function mailRoot(): string {
  return process.env.VALET_STUDIO_MAIL_DIR || join(homedir(), '.valet-studio', 'mail')
}

export function safeInbox(inbox: string): string {
  const name = (inbox || MAIL_DEFAULT_INBOX).trim().toLowerCase()
  if (!INBOX_RE.test(name) || name.includes('..')) return MAIL_DEFAULT_INBOX
  return name
}

function inboxDir(inbox: string): string {
  return join(mailRoot(), safeInbox(inbox))
}

function addressText(value?: AddressObject | AddressObject[]): string {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list
    .flatMap((entry) => entry.value)
    .map((item) => (item.name && item.address ? `${item.name} <${item.address}>` : item.address || item.name || ''))
    .filter(Boolean)
    .join(', ')
}

function headerValue(parsed: ParsedMail, key: string): string {
  const found = parsed.headerLines.find((h) => h.key.toLowerCase() === key.toLowerCase())
  if (!found) return ''
  const colon = found.line.indexOf(':')
  return colon >= 0 ? found.line.slice(colon + 1).trim() : found.line.trim()
}

function summaryOf(parsed: ParsedMail, base: { id: string; inbox: string; size: number; fallbackDate: Date }): MailSummary {
  const text = (parsed.text || '').replace(/\s+/g, ' ').trim()
  return {
    id: base.id,
    inbox: base.inbox,
    from: addressText(parsed.from) || 'Unknown sender',
    to: addressText(parsed.to),
    subject: parsed.subject?.trim() || '(no subject)',
    date: (parsed.date ?? base.fallbackDate).toISOString(),
    size: base.size,
    attachments: parsed.attachments.length,
    preview: text.slice(0, 180)
  }
}

function attachmentsOf(parsed: ParsedMail): MailAttachment[] {
  return parsed.attachments.map((a, index) => ({
    index,
    filename: a.filename || `attachment-${index + 1}`,
    contentType: a.contentType || 'application/octet-stream',
    size: a.size ?? a.content.length
  }))
}

function headersOf(parsed: ParsedMail): MailHeader[] {
  return parsed.headerLines.map((line) => {
    const colon = line.line.indexOf(':')
    return {
      key: line.key,
      value: colon >= 0 ? line.line.slice(colon + 1).trim() : line.line.trim()
    }
  })
}

/** Localiza el archivo de un id recorriendo las bandejas. */
async function findMessageFile(id: string): Promise<{ file: string; inbox: string } | null> {
  if (!ID_RE.test(id)) throw new Error('Invalid message id')
  const root = mailRoot()
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of dirs) {
    if (!entry.isDirectory() || !INBOX_RE.test(entry.name)) continue
    const file = join(root, entry.name, `${id}.eml`)
    try {
      await stat(file)
      return { file, inbox: entry.name }
    } catch {
      // No está en esta bandeja.
    }
  }
  return null
}

/** Lee un mensaje concreto. Lanza si el id no existe o no es válido. */
export async function readMessage(id: string): Promise<MailDetail> {
  const found = await findMessageFile(id)
  if (!found) throw new Error('Message not found')
  const [raw, info] = await Promise.all([readFile(found.file), stat(found.file)])
  const parsed = await simpleParser(raw)
  const summary = summaryOf(parsed, {
    id, inbox: found.inbox, size: info.size, fallbackDate: info.mtime
  })
  cache.set(`${found.inbox}/${id}`, {
    key: `${info.size}:${info.mtimeMs}`,
    summary
  })
  return {
    ...summary,
    cc: addressText(parsed.cc),
    bcc: addressText(parsed.bcc),
    replyTo: addressText(parsed.replyTo),
    messageId: parsed.messageId ?? headerValue(parsed, 'Message-ID'),
    html: typeof parsed.html === 'string' ? parsed.html : '',
    text: parsed.text ?? '',
    raw: raw.toString('utf8'),
    headers: headersOf(parsed),
    attachmentList: attachmentsOf(parsed)
  }
}

/** Mensajes de una bandeja, o de todas, del más nuevo al más antiguo. */
export async function listMessages(inbox?: string): Promise<MailSummary[]> {
  const root = mailRoot()
  const dirs = inbox
    ? [{ name: safeInbox(inbox), path: inboxDir(inbox) }]
    : (await readdir(root, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))

  const out: MailSummary[] = []
  for (const dir of dirs) {
    if (!INBOX_RE.test(dir.name)) continue
    const files = await readdir(dir.path).catch(() => [] as string[])
    for (const name of files) {
      if (!name.endsWith('.eml')) continue
      const id = name.slice(0, -4)
      if (!ID_RE.test(id)) continue
      const file = join(dir.path, name)
      const cacheKey = `${dir.name}/${id}`
      try {
        const info = await stat(file)
        const key = `${info.size}:${info.mtimeMs}`
        const cached = cache.get(cacheKey)
        if (cached?.key === key) {
          out.push(cached.summary)
          continue
        }
        const parsed = await simpleParser(await readFile(file))
        const summary = summaryOf(parsed, {
          id, inbox: dir.name, size: info.size, fallbackDate: info.mtime
        })
        cache.set(cacheKey, { key, summary })
        out.push(summary)
      } catch {
        // Un `.eml` a medio escribir o corrupto no rompe la lista entera.
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

export async function inboxCounts(): Promise<{ name: string; count: number }[]> {
  const all = await listMessages()
  const counts = new Map<string, number>()
  for (const message of all) counts.set(message.inbox, (counts.get(message.inbox) ?? 0) + 1)
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Guarda un mensaje recién recibido y devuelve su ficha. */
export async function saveMessage(inbox: string, raw: Buffer): Promise<MailSummary> {
  const name = safeInbox(inbox)
  const dir = inboxDir(name)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const id = `${Date.now()}-${randomBytes(3).toString('hex')}`
  const file = join(dir, `${id}.eml`)
  await writeFile(file, raw, { mode: 0o600, flag: 'wx' })
  const parsed = await simpleParser(raw)
  const summary = summaryOf(parsed, { id, inbox: name, size: raw.length, fallbackDate: new Date() })
  const info = await stat(file)
  cache.set(`${name}/${id}`, { key: `${info.size}:${info.mtimeMs}`, summary })
  return summary
}

/** Borra un mensaje por id. Devuelve `false` si ya no estaba. */
export async function deleteMessage(id: string): Promise<boolean> {
  const found = await findMessageFile(id)
  if (!found) return false
  await rm(found.file)
  cache.delete(`${found.inbox}/${id}`)
  return true
}

/** Vacía una bandeja concreta o todas. */
export async function clearMessages(inbox?: string): Promise<void> {
  if (inbox) {
    const name = safeInbox(inbox)
    await rm(inboxDir(name), { recursive: true, force: true })
    for (const key of cache.keys()) if (key.startsWith(`${name}/`)) cache.delete(key)
    return
  }
  await rm(mailRoot(), { recursive: true, force: true })
  cache.clear()
}

/** Contenido de un adjunto y un nombre seguro para guardarlo. */
export async function readAttachment(id: string, index: number): Promise<{ filename: string; content: Buffer }> {
  if (!Number.isInteger(index) || index < 0) throw new Error('Invalid attachment')
  const found = await findMessageFile(id)
  if (!found) throw new Error('Message not found')
  const parsed = await simpleParser(await readFile(found.file))
  const attachment = parsed.attachments[index]
  if (!attachment) throw new Error('Attachment not found')
  return {
    filename: basename(attachment.filename || `attachment-${index + 1}`),
    content: attachment.content
  }
}
