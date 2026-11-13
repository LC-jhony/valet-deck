import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodemailer from 'nodemailer'
import { createServer } from 'node:net'
import { inboxFor, MAIL_DEFAULT_INBOX, type MailSummary } from '../../shared/mail'
import { catcherState, startCatcher, stopCatcher, type CatcherState } from './server'
import {
  clearMessages, deleteMessage, inboxCounts, listMessages, readAttachment, readMessage,
  saveMessage, safeInbox
} from './store'

let dir = ''
let state: CatcherState
let received: MailSummary[] = []

function transport(user?: string) {
  return nodemailer.createTransport({
    host: '127.0.0.1',
    port: state.port,
    secure: false,
    ignoreTLS: true,
    auth: user === undefined ? undefined : { user, pass: 'anything' }
  })
}

async function waitFor(predicate: () => Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for mail')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'valet-mail-'))
  process.env.VALET_STUDIO_MAIL_DIR = dir
  received = []
  state = await startCatcher((summary) => received.push(summary), { port: 0, compatPort: null })
  expect(state.running).toBe(true)
})

afterEach(async () => {
  await stopCatcher()
  delete process.env.VALET_STUDIO_MAIL_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('bandejas del correo integrado', () => {
  it('sin usuario SMTP usa la bandeja default y normaliza nombres', () => {
    expect(inboxFor(undefined)).toBe(MAIL_DEFAULT_INBOX)
    expect(inboxFor(null)).toBe(MAIL_DEFAULT_INBOX)
    expect(inboxFor('')).toBe(MAIL_DEFAULT_INBOX)
    expect(inboxFor('null')).toBe(MAIL_DEFAULT_INBOX)
    expect(inboxFor('Mi Proyecto')).toBe('mi-proyecto')
    expect(safeInbox('../fuera')).toBe(MAIL_DEFAULT_INBOX)
    expect(safeInbox('A')).toBe('a')
  })

  it('el usuario SMTP elige la bandeja y el mensaje se guarda como .eml', async () => {
    const mail = transport('proyecto-a')
    await mail.sendMail({
      from: 'Laravel <app@example.test>',
      to: 'dev@example.test',
      subject: 'Reset your password',
      text: 'Plain body',
      html: '<p>Hola <a href="https://example.test">enlace</a></p>'
    })
    mail.close()

    await waitFor(async () => (await listMessages('proyecto-a')).length === 1)

    const messages = await listMessages('proyecto-a')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      inbox: 'proyecto-a',
      from: 'Laravel <app@example.test>',
      subject: 'Reset your password'
    })
    expect(received[0].id).toBe(messages[0].id)
    expect(await listMessages('default')).toHaveLength(0)

    const detail = await readMessage(messages[0].id)
    expect(detail.inbox).toBe('proyecto-a')
    expect(detail.text).toContain('Plain body')
    expect(detail.html).toContain('enlace')
    expect(detail.raw).toContain('Subject: Reset your password')
    expect(detail.headers.some((h) => h.key.toLowerCase() === 'subject')).toBe(true)
    expect(detail.attachmentList).toHaveLength(0)

    const counts = await inboxCounts()
    expect(counts).toEqual([{ name: 'proyecto-a', count: 1 }])
  })

  it('accepta cualquier credencial y separa los buzones por usuario', async () => {
    const first = transport('uno')
    const second = transport('dos')
    await first.sendMail({ from: 'a@example.test', to: 'a@example.test', subject: 'One', text: '1' })
    await second.sendMail({ from: 'b@example.test', to: 'b@example.test', subject: 'Two', text: '2' })
    first.close()
    second.close()

    await waitFor(async () => (await listMessages()).length === 2)
    expect((await listMessages('uno')).map((m) => m.subject)).toEqual(['One'])
    expect((await listMessages('dos')).map((m) => m.subject)).toEqual(['Two'])
  })

  it('guarda y devuelve los adjuntos', async () => {
    const mail = transport('adjuntos')
    await mail.sendMail({
      from: 'a@example.test',
      to: 'a@example.test',
      subject: 'With attachment',
      text: 'see attached',
      attachments: [{ filename: 'notes.txt', content: 'contenido del adjunto' }]
    })
    mail.close()

    await waitFor(async () => (await listMessages('adjuntos')).length === 1)
    const [summary] = await listMessages('adjuntos')
    expect(summary.attachments).toBe(1)

    const detail = await readMessage(summary.id)
    expect(detail.attachmentList[0]).toMatchObject({ filename: 'notes.txt', contentType: 'text/plain' })
    const file = await readAttachment(summary.id, 0)
    expect(file.filename).toBe('notes.txt')
    expect(file.content.toString('utf8')).toBe('contenido del adjunto')
  })

  it('borra un mensaje y vacía una bandeja sin tocar las demás', async () => {
    const stamp = Date.now()
    const one = await saveMessage('uno', Buffer.from(
      `From: a@example.test\r\nTo: a@example.test\r\nSubject: One ${stamp}\r\n\r\nBody\r\n`
    ))
    const two = await saveMessage('dos', Buffer.from(
      `From: b@example.test\r\nTo: b@example.test\r\nSubject: Two ${stamp}\r\n\r\nBody\r\n`
    ))
    expect(await listMessages()).toHaveLength(2)

    expect(await deleteMessage(one.id)).toBe(true)
    expect(await deleteMessage(one.id)).toBe(false)
    expect(await listMessages('uno')).toHaveLength(0)
    expect((await listMessages('dos')).map((m) => m.id)).toEqual([two.id])

    await clearMessages('dos')
    expect(await listMessages()).toHaveLength(0)
  })

  it('rechaza ids y rutas de bandeja que intentan salir del almacén', async () => {
    await expect(readMessage('../etc/passwd')).rejects.toThrow('Invalid message id')
    await expect(deleteMessage('123')).rejects.toThrow('Invalid message id')
    expect(await listMessages('../fuera')).toHaveLength(0)
    // Un nombre inválido se normaliza a default, nunca crea una carpeta fuera.
    expect(safeInbox('../../tmp')).toBe('default')
    expect(catcherState().running).toBe(true)
  })

  it('si el puerto está ocupado informa el fallo y no lanza una excepción', async () => {
    await stopCatcher()
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const address = blocker.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const next = await startCatcher(() => {}, { port, compatPort: null })
      expect(next.running).toBe(false)
      expect(next.error).toContain(`Could not listen on 127.0.0.1:${port}`)
    } finally {
      log.mockRestore()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})
