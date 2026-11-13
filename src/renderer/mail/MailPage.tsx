import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  MailDetail, MailInfo, MailSummary
} from '../../shared/mail'
import { MAIL_MAX_BYTES, MAIL_PORT, mailEnvBlock } from '../../shared/mail'
import { errorMessage } from '../errors'
import { Glyph } from '../ui-icons'
import type { Resource } from '../ui'

type MailTab = 'html' | 'text' | 'raw' | 'headers'

const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function shortDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : dateFmt.format(date)
}

function fullDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  })
}

/** Deja el HTML del mensaje sin scripts ni formularios y con los enlaces fuera. */
function prepareHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, iframe, object, embed, form, link, meta[http-equiv="refresh"]')
    .forEach((node) => node.remove())
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(element.attributes)) {
      if (/^on/i.test(attr.name)) element.removeAttribute(attr.name)
      if (/^(href|src|xlink:href)$/i.test(attr.name) && /^\s*(javascript|data:text\/html)/i.test(attr.value)) {
        element.removeAttribute(attr.name)
      }
    }
  }
  for (const link of Array.from(doc.querySelectorAll('a'))) {
    const href = link.getAttribute('href') ?? ''
    if (/^(https?:|mailto:)/i.test(href)) {
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noreferrer noopener')
    } else if (href) {
      link.removeAttribute('href')
    }
  }
  const csp = "default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'"
  const head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.documentElement.firstChild)
  const meta = doc.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', csp)
  head.prepend(meta)
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

// ── Sidebar: bandejas, búsqueda y lista de mensajes ──────────────────────

export function MailSidebar({ r, inbox, onInbox, selected, onSelect }: {
  r: Resource<MailInfo>
  inbox: string | null
  onInbox: (inbox: string | null) => void
  selected: string | null
  onSelect: (id: string | null) => void
}) {
  const [messages, setMessages] = useState<MailSummary[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const info = r.data

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setMessages(await window.api.mail.list(inbox ?? undefined))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [inbox])

  useEffect(() => { void load() }, [load, info?.messages])
  useEffect(() => window.api.mail.onEvent(() => { void load() }), [load])

  const q = query.trim().toLowerCase()
  const list = q
    ? messages.filter((m) =>
        m.subject.toLowerCase().includes(q) ||
        m.from.toLowerCase().includes(q) ||
        m.to.toLowerCase().includes(q) ||
        m.inbox.toLowerCase().includes(q))
    : messages

  return (
    <>
      <div className="side-search mail-side-search">
        <div className="search-box">
          <Glyph name="search" size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search mail"
            aria-label="Search mail"
            spellCheck={false}
          />
          {query && (
            <button className="side-clear" onClick={() => setQuery('')} aria-label="Clear search">
              <Glyph name="close" size={12} />
            </button>
          )}
        </div>
        <div className="mail-filters" role="group" aria-label="Filter by inbox">
          <button className={`mail-chip ${inbox === null ? 'active' : ''}`} onClick={() => onInbox(null)}>
            All {info ? <span>{info.messages}</span> : null}
          </button>
          {info?.inboxes.map((item) => (
            <button
              key={item.name}
              className={`mail-chip ${inbox === item.name ? 'active' : ''}`}
              onClick={() => onInbox(item.name)}
              title={`${item.count} message${item.count === 1 ? '' : 's'}`}
            >
              {item.name} <span>{item.count}</span>
            </button>
          ))}
        </div>
      </div>

      {(error || r.error) && (
        <div className="side-alert" role="alert"><Glyph name="alert" size={14} /><span>{error || r.error}</span></div>
      )}

      {loading && messages.length === 0 && (
        <div className="side-skeleton" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div className="side-skeleton-row" key={i}><span /><span /></div>
          ))}
        </div>
      )}

      {!loading && list.length === 0 && (
        <div className="side-empty">
          <Glyph name="mail" size={15} />
          <span>{q ? 'No message matches that search.' : 'No messages yet. Send one from your app or use the test form.'}</span>
        </div>
      )}

      <ul className="mail-list">
        {list.map((message) => (
          <li key={message.id}>
            <button
              className={`mail-item ${selected === message.id ? 'active' : ''}`}
              onClick={() => onSelect(message.id)}
              aria-current={selected === message.id ? 'true' : undefined}
            >
              <span className="mail-item-top">
                <span className="mail-item-from">{message.from}</span>
                <time dateTime={message.date}>{shortDate(message.date)}</time>
              </span>
              <span className="mail-item-subject">{message.subject}</span>
              <span className="mail-item-preview">{message.preview || 'No text content'}</span>
              <span className="mail-item-meta">
                <span className="mail-inbox-pill">{message.inbox}</span>
                {message.attachments > 0 && (
                  <span className="mail-attach-count" title={`${message.attachments} attachment(s)`}>
                    <Glyph name="mail" size={11} />{message.attachments}
                  </span>
                )}
                <span>{formatBytes(message.size)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

// ── Página: mensaje seleccionado o estado vacío ──────────────────────────

export function MailPage({ r, id, inbox, onSelect }: {
  r: Resource<MailInfo>
  id: string | null
  inbox: string | null
  onSelect: (id: string | null) => void
}) {
  const [detail, setDetail] = useState<MailDetail | null>(null)
  const [tab, setTab] = useState<MailTab>('html')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [to, setTo] = useState('')
  const [testInbox, setTestInbox] = useState(inbox ?? 'default')
  const info = r.data

  const load = useCallback(async () => {
    if (!id) { setDetail(null); return }
    setLoading(true)
    setError('')
    try {
      setDetail(await window.api.mail.get(id))
    } catch (e) {
      setDetail(null)
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setTestInbox(inbox ?? 'default') }, [inbox])
  // Al cambiar de mensaje se vuelve a HTML, pero el aviso de la acción anterior
  // (por ejemplo «Message deleted») se conserva hasta la siguiente acción.
  useEffect(() => { setTab('html') }, [id])

  const html = useMemo(() => (detail?.html ? prepareHtml(detail.html) : ''), [detail?.html])

  const run = async (
    action: () => Promise<unknown>,
    message = '',
    refreshDetail = true
  ) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      if (message) setNotice(message)
      // Tras borrar, el mensaje ya no existe: recargarlo daría un error falso.
      if (refreshDetail) await load()
      r.reload()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = () => {
    if (!detail) return
    if (!confirm(`Delete "${detail.subject}"?`)) return
    void run(async () => {
      await window.api.mail.remove(detail.id)
      onSelect(null)
    }, 'Message deleted.', false)
  }

  const clear = () => {
    const target = inbox ? `the "${inbox}" inbox` : 'every message'
    if (!confirm(`Delete ${target}? This cannot be undone.`)) return
    void run(async () => {
      await window.api.mail.clear(inbox ?? undefined)
      onSelect(null)
    }, 'Mail cleared.', false)
  }

  const saveAttachment = async (index: number) => {
    if (!detail) return
    setError('')
    try {
      const path = await window.api.mail.saveAttachment(detail.id, index)
      if (path) setNotice(`Saved to ${path}`)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const test = () => {
    if (!to.trim()) return
    setBusy(true)
    setError('')
    setNotice('')
    window.api.mail.sendTest(to.trim(), testInbox)
      .then(() => {
        setNotice(`Test message delivered to the "${testInbox}" inbox.`)
        setTo('')
        r.reload()
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false))
  }

  const env = mailEnvBlock('${APP_NAME}', info?.port ?? MAIL_PORT)
  const port = info?.port ?? MAIL_PORT

  return (
    <div className="mail-page">
      <header className="mail-toolbar">
        <div className="mail-server-state">
          <span className={`mail-dot ${info?.running ? 'ok' : 'bad'}`} aria-hidden="true" />
          <div>
            <strong>{info?.running ? 'Mail catcher listening' : 'Mail catcher offline'}</strong>
            <span>
              {info ? `${info.host}:${info.port}` : `127.0.0.1:${MAIL_PORT}`}
              {info?.compatPort ? ` and :${info.compatPort}` : ''}
              {info ? ` · ${info.messages} message${info.messages === 1 ? '' : 's'}` : ''}
            </span>
          </div>
        </div>
        <div className="mail-toolbar-actions">
          <button className="btn ghost" onClick={() => void window.api.mail.openData()}>
            <Glyph name="sites" size={14} />Open folder
          </button>
          <button className="btn ghost" onClick={clear} disabled={busy || !info?.messages}>
            <Glyph name="trash" size={14} />Clear {inbox ?? 'all'}
          </button>
        </div>
      </header>

      {(info?.error || r.error || error) && (
        <div className="error mail-error" role="alert">
          <Glyph name="alert" size={15} /><span>{info?.error || r.error || error}</span>
        </div>
      )}
      {notice && (
        <div className="mail-notice" role="status"><Glyph name="check" size={14} /><span>{notice}</span></div>
      )}

      {loading && id && !detail && <div className="mail-loading"><Glyph name="spinner" size={18} className="spin" />Loading message…</div>}

      {!id && (
        <div className="mail-empty">
          <div className="mail-empty-copy">
            <span className="mail-empty-icon"><Glyph name="mail" size={26} /></span>
            <h1>Your local mail, caught here</h1>
            <p>
              Every message an app sends to <code>127.0.0.1:{port}</code> is stored on this
              computer. Nothing is delivered to a real inbox. The SMTP username picks the inbox:
              projects with different <code>MAIL_USERNAME</code> do not mix.
            </p>
          </div>

          <div className="mail-empty-grid">
            <section className="mail-card">
              <div className="section-head">
                <h2>Laravel .env</h2>
                <span className="tag">ready to copy</span>
              </div>
              <pre className="mail-env-block">{env}</pre>
              <div className="mail-card-actions">
                <button className="btn" onClick={() => { copyText(env); setNotice('Environment block copied.') }}>
                  <Glyph name="copy" size={13} />Copy block
                </button>
                <span className="mail-hint">Up to {formatBytes(MAIL_MAX_BYTES)} per message, attachments included.</span>
              </div>
            </section>

            <section className="mail-card">
              <div className="section-head">
                <h2>Credentials</h2>
                <span className="tag">any password</span>
              </div>
              <dl className="mail-facts">
                <div>
                  <dt>Host</dt>
                  <dd><code>127.0.0.1:{port}</code></dd>
                </div>
                <div>
                  <dt>Username</dt>
                  <dd>
                    Picks the inbox. Empty or <code>null</code> lands in{' '}
                    <code>default</code>.
                  </dd>
                </div>
                <div>
                  <dt>Password</dt>
                  <dd>
                    Any value works. The panel writes{' '}
                    <code>MAIL_PASSWORD=null</code> for you.
                  </dd>
                </div>
                <div>
                  <dt>Encryption</dt>
                  <dd>None on loopback. Keep <code>MAIL_SCHEME=null</code>.</dd>
                </div>
              </dl>
            </section>

            <section className="mail-card">
              <div className="section-head">
                <h2>Send a test</h2>
                <span className="tag">{testInbox}</span>
              </div>
              <label className="field-block">
                <span className="field-block-label">To</span>
                <input
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="you@example.test"
                  inputMode="email"
                  spellCheck={false}
                />
              </label>
              <label className="field-block">
                <span className="field-block-label">Inbox (SMTP username)</span>
                <input
                  value={testInbox}
                  onChange={(e) => setTestInbox(e.target.value)}
                  placeholder="default"
                  spellCheck={false}
                />
              </label>
              <div className="mail-card-actions">
                <button className="btn primary" onClick={test} disabled={busy || !to.trim()}>
                  <Glyph name={busy ? 'spinner' : 'mail'} size={13} className={busy ? 'spin' : ''} />
                  Send test message
                </button>
              </div>
            </section>
          </div>
        </div>
      )}

      {id && detail && (
        <article className="mail-detail">
          <header className="mail-detail-head">
            <div className="mail-detail-copy">
              <h1>{detail.subject}</h1>
              <div className="mail-addresses">
                <div><span>From</span><strong>{detail.from}</strong></div>
                <div><span>To</span><strong>{detail.to || '—'}</strong></div>
                {detail.cc && <div><span>Cc</span><strong>{detail.cc}</strong></div>}
                <div><span>Date</span><strong>{fullDate(detail.date)}</strong></div>
              </div>
              <div className="mail-detail-meta">
                <span className="mail-inbox-pill">{detail.inbox}</span>
                <span>{formatBytes(detail.size)}</span>
                {detail.messageId && <code>{detail.messageId}</code>}
              </div>
            </div>
            <div className="mail-detail-actions">
              <button className="btn ghost" onClick={() => onSelect(null)}>Back</button>
              <button className="btn danger" onClick={remove} disabled={busy}>
                <Glyph name="trash" size={13} />Delete
              </button>
            </div>
          </header>

          {detail.attachmentList.length > 0 && (
            <div className="mail-attachments">
              <span className="mail-attachments-label">Attachments</span>
              {detail.attachmentList.map((attachment) => (
                <button
                  key={attachment.index}
                  className="mail-attachment"
                  onClick={() => void saveAttachment(attachment.index)}
                  title="Save attachment"
                >
                  <Glyph name="install" size={13} />
                  <span>{attachment.filename}</span>
                  <small>{formatBytes(attachment.size)}</small>
                </button>
              ))}
            </div>
          )}

          <div className="mail-tabs" role="tablist" aria-label="Message view">
            {(['html', 'text', 'raw', 'headers'] as MailTab[]).map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={tab === value}
                className={`mail-tab ${tab === value ? 'active' : ''}`}
                onClick={() => setTab(value)}
              >
                {value === 'html' ? 'HTML' : value === 'text' ? 'Text' : value === 'raw' ? 'Raw' : 'Headers'}
              </button>
            ))}
            <span className="mail-tab-spacer" />
            <button className="btn ghost mail-copy" onClick={() => { copyText(detail.raw); setNotice('Raw message copied.') }}>
              <Glyph name="copy" size={13} />Copy raw
            </button>
          </div>

          <div className={`mail-body mail-body-${tab}`}>
            {tab === 'html' && (
              html
                ? <iframe className="mail-html" title="Message HTML" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={html} />
                : <pre className="mail-pre">{detail.text || 'This message has no HTML part.'}</pre>
            )}
            {tab === 'text' && <pre className="mail-pre">{detail.text || 'This message has no text part.'}</pre>}
            {tab === 'raw' && <pre className="mail-pre">{detail.raw}</pre>}
            {tab === 'headers' && (
              <table className="mail-headers">
                <tbody>
                  {detail.headers.map((header, index) => (
                    <tr key={`${header.key}-${index}`}>
                      <th scope="row">{header.key}</th>
                      <td>{header.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </article>
      )}

      {id && !detail && !loading && (
        <div className="mail-empty">
          <div className="mail-empty-copy">
            <span className="mail-empty-icon"><Glyph name="alert" size={24} /></span>
            <h1>Message not available</h1>
            <p>It may have been deleted. Pick another message from the list.</p>
            <button className="btn" onClick={() => onSelect(null)}>Back to mail</button>
          </div>
        </div>
      )}
    </div>
  )
}
