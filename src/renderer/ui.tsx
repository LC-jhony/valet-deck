// Primitivas de interfaz compartidas por todas las páginas. Se extrajeron de
// App.tsx para que las vistas nuevas (sitio, PHP, Node, bases de datos,
// ajustes y panel) usen la misma cabecera, los mismos esqueletos y los mismos
// controles sin duplicar marcado.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { errorMessage } from './errors'
import { Glyph, type GlyphName } from './ui-icons'

export interface Resource<T> {
  data?: T
  error: string
  loading: boolean
  reload: () => void
}

export function useResource<T>(loadFn: () => Promise<T>, active = true): Resource<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(active)
  const ticket = useRef(0)

  const load = useCallback(() => {
    const id = ++ticket.current
    setLoading(true)
    setError('')
    loadFn()
      .then((value) => { if (ticket.current === id) setData(value) })
      .catch((e: unknown) => { if (ticket.current === id) setError(errorMessage(e)) })
      .finally(() => { if (ticket.current === id) setLoading(false) })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (active) load() }, [active, load])
  return { data, error, loading, reload: load }
}

export function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const act = useCallback(async (run: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await run()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      reload()
    }
  }, [reload])
  return { busy, error, act }
}

export function Page({ title, hint, error, loading, onRefresh, actions, children }: {
  title: string
  hint: string
  error: string
  loading: boolean
  onRefresh: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="page">
      <header className="page-head">
        <div className="page-copy">
          <h1>{title}</h1>
          <p>{hint}</p>
        </div>
        <div className="page-actions">
          {actions}
          <button className="btn" onClick={onRefresh} disabled={loading} aria-label={loading ? 'Refreshing' : 'Refresh'} title="Refresh">
            <Glyph name="refresh" size={14} className={loading ? 'spin' : ''} />
            <span className="btn-label">{loading ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>
      </header>
      {error && <div className="error" role="alert"><Glyph name="alert" size={15} /><span>{error}</span></div>}
      {children}
    </section>
  )
}

export function EmptyState({ icon = 'info', title, children }: { icon?: GlyphName; title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <Glyph name={icon} size={18} />
      <div><strong>{title}</strong><p>{children}</p></div>
    </div>
  )
}

export function RowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <span className="sk-icon" />
          <span className="sk-lines"><span className="sk-line w1" /><span className="sk-line w2" /></span>
        </div>
      ))}
    </div>
  )
}

/** Grupo de opciones con el mismo aspecto que los segmentos de Configuración. */
export function Seg<T extends string>({ label, value, options, onChange, disabled }: {
  label: string
  value: T
  options: [T, ReactNode][]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={value === v ? 'on' : ''}
          disabled={disabled}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** Etiqueta + control, con una nota opcional debajo. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field-block">
      <span className="field-block-label">{label}</span>
      {children}
      {hint && <small className="field-block-hint">{hint}</small>}
    </label>
  )
}

/** Tarjeta con cabecera, icono y una etiqueta de estado a la derecha. */
export function Panel({ id, icon, title, tag, children, className = '' }: {
  id?: string
  icon?: ReactNode
  title: string
  tag?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div id={id} className={`panel panel-block ${className}`.trim()}>
      <div className="panel-head">
        {icon && <span className="panel-icon">{icon}</span>}
        <h2 className="panel-title">{title}</h2>
        {tag && <span className="panel-head-tag">{tag}</span>}
      </div>
      {children}
    </div>
  )
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok'; children: ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === 'warn' ? 'alert' : undefined}>
      <Glyph name={tone === 'ok' ? 'check' : tone === 'warn' ? 'alert' : 'info'} size={14} />
      <span>{children}</span>
    </div>
  )
}

export function Metric({ label, value, detail, icon, onClick }: {
  label: string
  value: ReactNode
  detail?: ReactNode
  icon?: ReactNode
  onClick?: () => void
}) {
  const content = (
    <>
      <span className="metric-top">
        <span className="metric-label">{label}</span>
        {icon && <span className="metric-icon">{icon}</span>}
      </span>
      <strong className="metric-value">{value}</strong>
      {detail && <span className="metric-detail">{detail}</span>}
    </>
  )
  return onClick
    ? <button type="button" className="metric metric-btn" onClick={onClick}>{content}</button>
    : <div className="metric">{content}</div>
}

/** Registro en vivo de una tarea larga (instalar PHP o Node). */
export function TaskOutput({ text, busy, done, error }: {
  text: string
  busy: boolean
  done?: string
  error?: string
}) {
  if (!text && !busy && !done && !error) return null
  return (
    <div className="task-output">
      <div className="section-head">
        <h2>Output</h2>
        {busy && <span className="muted inline"><Glyph name="spinner" size={13} className="spin" />working…</span>}
        {!busy && done && <span className="tag on"><Glyph name="check" size={11} />{done}</span>}
        {!busy && error && <span className="tag warn"><Glyph name="alert" size={11} />failed</span>}
      </div>
      {error && <Notice tone="warn">{error}</Notice>}
      {text && <pre className="log">{text}</pre>}
    </div>
  )
}

/** `1536` → `1.5 kB`. Los tamaños de la interfaz se leen de un vistazo. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** Fecha corta y legible; las fechas inválidas no rompen la fila. */
export function formatDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
  } catch {
    return '—'
  }
}
