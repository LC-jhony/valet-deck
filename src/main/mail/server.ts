/**
 * Servidor SMTP de recepción. Escucha solo en loopback, acepta cualquier
 * credencial y usa el usuario SMTP como bandeja, igual que Flock: así cada
 * proyecto puede tener su propio buzón sin mezclar mensajes.
 */

import {
  SMTPServer,
  type SMTPServerDataStream,
  type SMTPServerSession
} from 'smtp-server'
import {
  MAIL_COMPAT_PORT, MAIL_HOST, MAIL_MAX_BYTES, MAIL_PORT, inboxFor, type MailSummary
} from '../../shared/mail'
import { saveMessage } from './store'

export interface CatcherState {
  running: boolean
  port: number
  compatPort: number | null
  error: string
}

export interface CatcherOptions {
  /** Puerto principal; `0` deja que el sistema elija uno libre (pruebas). */
  port?: number
  /** Puerto de compatibilidad; `null` lo desactiva. */
  compatPort?: number | null
}

let primary: SMTPServer | null = null
let compat: SMTPServer | null = null
let state: CatcherState = {
  running: false,
  port: MAIL_PORT,
  compatPort: null,
  error: ''
}

/** Puertos alternativos si el 2525 está ocupado (por ejemplo, por Flock). */
const FALLBACK_PORTS = [2526, 2527, 2528, 2529]

function readMessage(stream: SMTPServerDataStream, session: SMTPServerSession): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAIL_MAX_BYTES) {
        stream.destroy()
        reject(new Error('Message too large'))
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
    // `smtp-server` ya conoce el límite del comando SIZE; esto cubre clientes
    // que no lo anuncian o lo ignoran.
    if (stream.sizeExceeded) reject(new Error('Message too large'))
    void session
  })
}

function makeServer(onMessage: (summary: MailSummary) => void): SMTPServer {
  const server = new SMTPServer({
    name: 'Valet Deck Mail',
    banner: 'Valet Deck mail catcher',
    authOptional: true,
    allowInsecureAuth: true,
    disableReverseLookup: true,
    // Sin TLS: es un catcher local que nunca sale del equipo.
    disabledCommands: ['STARTTLS'],
    hideSTARTTLS: true,
    size: MAIL_MAX_BYTES,
    onAuth(auth, session, callback) {
      // Cualquier usuario y contraseña valen; el usuario elige la bandeja.
      callback(null, { user: auth.username || session.user || '' })
    },
    onData(stream, session, callback) {
      void readMessage(stream, session)
        .then(async (raw) => {
          if (stream.sizeExceeded) throw new Error('Message too large')
          const summary = await saveMessage(inboxFor(session.user), raw)
          onMessage(summary)
          callback(null)
        })
        .catch((e: Error) => callback(e))
    }
  })
  // `smtp-server` reemite los errores del socket en su propia instancia. Sin
  // este listener, un puerto ocupado se convierte en una excepción no capturada
  // y Electron abre un diálogo de error. El fallo de arranque se informa por
  // `startCatcher` (o se resuelve probando el siguiente puerto).
  server.on('error', (e: Error) => {
    if (server.server.listening) console.error(`[mail] SMTP server error: ${e.message}`)
  })
  return server
}

function listen(server: SMTPServer, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    // `smtp-server` delega en un `net.Server`: el evento `listening` se emite
    // ahí, no en la instancia de SMTPServer, pero los errores se reemiten en
    // ambas. Se escuchan los dos y se limpian al resolver.
    const net = server.server
    const cleanup = () => {
      net.removeListener('error', onError)
      server.removeListener('error', onError)
      net.removeListener('listening', onListening)
    }
    const onError = (e: Error) => {
      cleanup()
      reject(e)
    }
    const onListening = () => {
      cleanup()
      const address = net.address()
      resolve(address && typeof address === 'object' ? address.port : port)
    }
    net.once('error', onError)
    server.once('error', onError)
    net.once('listening', onListening)
    server.listen(port, MAIL_HOST)
  })
}

/**
 * Arranca el catcher principal (2525 y alternativos si están ocupados) y, si
 * está libre, el puerto antiguo 1025. Devuelve el puerto real para que la
 * interfaz y los `.env` no anuncien uno que no está escuchando.
 */
export async function startCatcher(
  onMessage: (summary: MailSummary) => void,
  options: CatcherOptions = {}
): Promise<CatcherState> {
  if (primary) return state
  const requestedPort = options.port ?? MAIL_PORT
  // Con un puerto explícito (pruebas) no se prueba otro: el fallo se informa.
  const candidates = options.port === undefined ? [MAIL_PORT, ...FALLBACK_PORTS] : [requestedPort]
  const compatPort = options.compatPort === undefined ? MAIL_COMPAT_PORT : options.compatPort

  let bound: number | null = null
  let lastError: Error | null = null
  for (const port of candidates) {
    const server = makeServer(onMessage)
    try {
      bound = await listen(server, port)
      primary = server
      break
    } catch (e) {
      lastError = e as Error
      server.close()
    }
  }

  if (!primary || bound === null) {
    state = {
      running: false,
      port: requestedPort,
      compatPort: null,
      error: `Could not listen on ${MAIL_HOST}:${requestedPort}: ${lastError?.message ?? 'unknown error'}`
    }
    return state
  }

  state = { running: true, port: bound, compatPort: null, error: '' }

  // Compatibilidad con los `.env` antiguos que apuntaban al 1025. Si el puerto
  // está ocupado no es un fallo: el puerto recomendado sigue activo.
  if (compatPort !== null) {
    const legacy = makeServer(onMessage)
    try {
      state.compatPort = await listen(legacy, compatPort)
      compat = legacy
    } catch {
      legacy.close()
    }
  }
  return state
}

export function catcherState(): CatcherState {
  return state
}

/** Cierra los listeners al salir. */
export async function stopCatcher(): Promise<void> {
  const servers = [primary, compat].filter((s): s is SMTPServer => Boolean(s))
  primary = null
  compat = null
  state = { ...state, running: false, compatPort: null }
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
}
