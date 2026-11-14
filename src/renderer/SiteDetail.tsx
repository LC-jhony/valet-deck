// Ficha completa de un sitio. Reúne en una sola página lo que antes había que
// mirar en cinco consolas distintas: framework y dominios, `.env`, base de
// datos, correo, colas, versiones de PHP/Node y registros.
//
// Las contraseñas del `.env` no llegan a esta ventana: el proceso principal
// envía `passwordSet` y aquí solo se escribe un valor nuevo cuando el usuario
// lo teclea. Toda escritura crea antes una copia con permisos 0600.

import { useEffect, useMemo, useState } from 'react'
import { DATABASE_LABELS, defaultDatabasePort, type DatabaseDriver } from '../shared/laravel'
import { compareVersions } from '../shared/site-files'
import type {
  EnvWrite, SiteDatabaseInput, SiteDetail as Detail, SiteMailInput, SiteQueue
} from '../shared/site'
import type { Tab } from './nav'
import { CommandBlock } from './CommandBlock'
import {
  EmptyState, Notice, Panel, Page, RowsSkeleton, TaskOutput, formatBytes, useResource
} from './ui'
import { Glyph } from './ui-icons'

type DetailTab = 'overview' | 'env' | 'database' | 'mail' | 'queue' | 'versions' | 'logs'

const TABS: { id: DetailTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'env', label: 'Environment' },
  { id: 'database', label: 'Database' },
  { id: 'mail', label: 'Mail' },
  { id: 'queue', label: 'Queues' },
  { id: 'versions', label: 'PHP & Node.js' },
  { id: 'logs', label: 'Logs' }
]

type RunFn = (label: string, fn: () => Promise<Detail | void>) => Promise<void>

const numberOr = (value: string, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

function FrameworkTag({ detail }: { detail: Detail }) {
  const label = detail.framework === 'laravel'
    ? `Laravel${detail.laravelVersion ? ` ${detail.laravelVersion.replace(/^v/, '')}` : ''}`
    : detail.framework === 'php' ? 'PHP' : 'Static'
  return <span className="tag info">{label}</span>
}

function SourceTag({ source }: { source: 'isolated' | 'default' | 'pinned' }) {
  if (source === 'isolated') return <span className="tag on">isolated</span>
  if (source === 'pinned') return <span className="tag info">pinned</span>
  return <span className="tag">default</span>
}

// ── Overview ─────────────────────────────────────────────────────────────

function OverviewTab({ detail, busy, run, onNavigate }: {
  detail: Detail
  busy: string
  run: RunFn
  onNavigate: (tab: Tab) => void
}) {
  const [domain, setDomain] = useState('')
  const [httpsNote, setHttpsNote] = useState('')
  const extra = detail.domains.filter((d) => !d.primary)
  const domainReady = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain.trim().toLowerCase())

  const addDomain = () => {
    const value = domain.trim().toLowerCase()
    if (!domainReady) return
    void run('domain', () => window.api.sites.updateSettings(detail.name, { domains: [...extra.map((d) => d.name), value] }))
      .then(() => setDomain(''))
  }

  const removeDomain = (name: string) => {
    void run('domain', () => window.api.sites.updateSettings(detail.name, {
      domains: extra.filter((d) => d.name !== name).map((d) => d.name)
    }))
  }

  return (
    <>
      {detail.warnings.length > 0 && (
        <div className="notice-stack">
          {detail.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
        </div>
      )}

      <div className="site-hero">
        <span className="site-hero-icon"><Glyph name="sites" size={22} /></span>
        <div className="site-hero-tags">
          <FrameworkTag detail={detail} />
          <span className="tag">{detail.kind}</span>
          <span className={`tag ${detail.secure ? 'on' : ''}`}>{detail.secure ? 'HTTPS' : 'HTTP'}</span>
        </div>
        <div className="panel-actions">
          <button className="btn primary" disabled={Boolean(busy)} onClick={() => void run('open', () => window.api.sites.open(detail.name))}>
            <Glyph name="globe" size={13} />Open site
          </button>
          <button className="btn" disabled={Boolean(busy)} onClick={() => void run('folder', () => window.api.sites.openFolder(detail.name))}>
            <Glyph name="sites" size={13} />Open folder
          </button>
          <button className="btn" disabled={Boolean(busy)}
            onClick={() => void run('https', async () => {
              const enabling = !detail.secure
              await window.api.sites.secure(detail.name, enabling)
              const next = await window.api.sites.detail(detail.name)
              setHttpsNote(enabling
                ? 'HTTPS enabled. If the browser warns about the certificate, quit it completely and reopen it once so it reads Valet’s local CA.'
                : '')
              return next
            })}>
            <Glyph name={detail.secure ? 'unlock' : 'lock'} size={13} />
            {detail.secure ? 'Disable HTTPS' : 'Enable HTTPS'}
          </button>
        </div>
      </div>

      {httpsNote && <Notice tone="info">{httpsNote}</Notice>}

      <div className="metric-grid metric-grid-3">
        <div className="metric">
          <span className="metric-top"><span className="metric-label">PHP</span><span className="metric-icon"><Glyph name="php" size={18} /></span></span>
          <strong className="metric-value">{detail.php.version || '—'}</strong>
          <span className="metric-detail"><SourceTag source={detail.php.source} /> {detail.php.isolatedFile ? 'own nginx config' : 'follows Valet'}</span>
        </div>
        <div className="metric">
          <span className="metric-top"><span className="metric-label">Node.js</span><span className="metric-icon"><Glyph name="terminal" size={18} /></span></span>
          <strong className="metric-value">{detail.node.version || '—'}</strong>
          <span className="metric-detail"><SourceTag source={detail.node.source} /> {detail.node.pinnedFile ?? 'no file pinned'}</span>
        </div>
        <div className="metric">
          <span className="metric-top"><span className="metric-label">Database</span><span className="metric-icon"><Glyph name="database" size={18} /></span></span>
          <strong className="metric-value">{detail.database?.connection ?? '—'}</strong>
          <span className="metric-detail">
            {detail.database?.database || 'no .env'}
            {detail.database?.reachable === true && <span className="tag on">reachable</span>}
            {detail.database?.reachable === false && <span className="tag warn">unreachable</span>}
          </span>
        </div>
      </div>

      <div className="dash-columns">
        <Panel icon={<Glyph name="globe" size={16} />} title="Domains" tag={<span className="tag">{detail.domains.length}</span>}>
          <ul className="mini-list">
            {detail.domains.map((d) => (
              <li key={d.name}>
                <Glyph name="globe" size={14} />
                <span className="mini-name"><code>{d.name}</code></span>
                {d.primary
                  ? <span className="tag on">primary</span>
                  : (
                    <button className="btn ghost btn-mini" disabled={Boolean(busy)} onClick={() => removeDomain(d.name)}>
                      Remove
                    </button>
                  )}
              </li>
            ))}
          </ul>
          <div className="inline-form">
            <label className="field-block">
              <span className="field-block-label">Add a domain</span>
              <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={`another.${detail.domains[0]?.name.split('.').slice(-1)[0] ?? 'test'}`} spellCheck={false} />
            </label>
            <button className="btn" disabled={Boolean(busy) || !domainReady} onClick={addDomain}>
              <Glyph name="plus" size={13} />Add
            </button>
          </div>
          <p className="panel-note">Extra names resolve through the same Valet DNS entry; no new certificate is created for them.</p>
        </Panel>

        <Panel icon={<Glyph name="sites" size={16} />} title="Project">
          <dl className="kv">
            <div><dt>Document root</dt><dd><code>{detail.documentRoot}</code></dd></div>
            <div><dt>Framework</dt><dd><FrameworkTag detail={detail} /></dd></div>
            <div><dt>Composer PHP</dt><dd>{detail.composerPhp ?? 'not declared'}</dd></div>
            <div><dt>Valet link</dt><dd>{detail.kind === 'linked' ? 'linked site' : 'inside a parked folder'}</dd></div>
          </dl>
          <div className="panel-actions">
            <button className="btn" onClick={() => onNavigate('database')}>All databases</button>
            <button className="btn ghost" onClick={() => onNavigate('php')}>PHP versions</button>
          </div>
        </Panel>
      </div>

      <Panel icon={<Glyph name="php" size={16} />} title="Extensions" tag={<span className="tag">{detail.extensions.length}</span>}>
        {detail.extensions.length === 0
          ? <p className="panel-note">This project does not declare any PHP extension and its <code>.env</code> does not imply one.</p>
          : (
            <ul className="rows rows-flat">
              {detail.extensions.map((ext) => (
                <li key={ext.name}>
                  <div className="row-main">
                    <span className="row-icon"><Glyph name="php" size={16} /></span>
                    <div className="row-text"><strong>{ext.name}</strong><small>{ext.source}</small></div>
                  </div>
                  <div className="row-meta">
                    {ext.required && <span className="tag info">required</span>}
                    <span className={`tag ${ext.enabled ? 'on' : 'warn'}`}>{ext.enabled ? 'enabled' : 'missing'}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </>
  )
}

// ── Environment ──────────────────────────────────────────────────────────

function EnvTab({ detail, busy, run }: { detail: Detail; busy: string; run: RunFn }) {
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    setEdits({})
    setRemoved(new Set())
    setNote('')
  }, [detail.name])

  const q = filter.trim().toLowerCase()
  const visible = q ? detail.env.filter((e) => e.key.toLowerCase().includes(q)) : detail.env
  const added = Object.keys(edits).filter((key) => !detail.env.some((e) => e.key === key))

  const changes = useMemo<EnvWrite[]>(() => {
    const out: EnvWrite[] = []
    for (const [key, value] of Object.entries(edits)) {
      const entry = detail.env.find((e) => e.key === key)
      if (!entry) {
        if (value !== '') out.push({ key, value })
        continue
      }
      if (entry.secret) {
        if (value !== '') out.push({ key, value })
      } else if (value !== entry.value) {
        out.push({ key, value })
      }
    }
    for (const key of removed) out.push({ key, value: null })
    return out
  }, [edits, removed, detail.env])

  const add = () => {
    const key = newKey.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      setNote('Keys use letters, numbers and underscores, and cannot start with a number.')
      return
    }
    if (detail.env.some((e) => e.key === key) || edits[key] !== undefined) {
      setNote(`${key} already exists. Edit its value instead.`)
      return
    }
    setEdits((prev) => ({ ...prev, [key]: newValue }))
    setNewKey('')
    setNewValue('')
    setNote('')
  }

  const save = async () => {
    setNote('')
    await run('env', async () => {
      const next = await window.api.sites.setEnv(detail.name, changes)
      setEdits({})
      setRemoved(new Set())
      return next
    })
  }

  return (
    <>
      <Notice tone="info">
        Saving copies the current <code>.env</code> to <code>~/.valet-studio/backups</code> first and
        writes the file with permissions 0600. Secret values are never sent back to this window.
      </Notice>

      <Panel
        icon={<Glyph name="settings" size={16} />}
        title="Environment variables"
        tag={
          <>
            <span className="tag">{detail.env.length} keys</span>
            {changes.length > 0 && <span className="tag info">{changes.length} pending</span>}
          </>
        }
      >
        <div className="inline-form">
          <label className="field-block">
            <span className="field-block-label">Filter</span>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="DB_, MAIL_, APP_" spellCheck={false} />
          </label>
          <button className="btn primary" disabled={Boolean(busy) || changes.length === 0} onClick={() => void save()}>
            <Glyph name={busy === 'env' ? 'spinner' : 'check'} size={13} className={busy === 'env' ? 'spin' : ''} />
            Save changes
          </button>
          <button className="btn ghost" disabled={changes.length === 0} onClick={() => { setEdits({}); setRemoved(new Set()); setNote('') }}>
            Reset
          </button>
        </div>

        {visible.length === 0
          ? <EmptyState icon="settings" title="No variables">There is no <code>.env</code> yet or nothing matches the filter.</EmptyState>
          : (
            <ul className="env-list">
              {visible.map((entry) => {
                const isRemoved = removed.has(entry.key)
                const value = edits[entry.key]
                return (
                  <li key={entry.key} className={isRemoved ? 'removed' : ''}>
                    <span className="env-key"><code>{entry.key}</code>{entry.secret && <span className="tag">secret</span>}</span>
                    <input
                      type={entry.secret ? 'password' : 'text'}
                      value={value ?? (entry.secret ? '' : entry.value)}
                      placeholder={entry.secret && entry.set ? 'Stored — write a new one to replace it' : entry.secret ? 'Not set' : ''}
                      disabled={isRemoved}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [entry.key]: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <span className="env-state">
                      {isRemoved
                        ? <span className="tag warn">will be removed</span>
                        : entry.secret
                          ? <span className={`tag ${entry.set ? 'on' : ''}`}>{entry.set ? 'set' : 'empty'}</span>
                          : value !== undefined && value !== entry.value
                            ? <span className="tag info">edited</span>
                            : null}
                    </span>
                    <button className="btn ghost btn-mini" disabled={Boolean(busy)}
                      onClick={() => {
                        setRemoved((prev) => {
                          const next = new Set(prev)
                          if (next.has(entry.key)) next.delete(entry.key)
                          else next.add(entry.key)
                          return next
                        })
                      }}>
                      {isRemoved ? 'Undo' : 'Remove'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

        {added.length > 0 && (
          <ul className="env-list env-pending">
            {added.map((key) => (
              <li key={key}>
                <span className="env-key"><code>{key}</code><span className="tag info">new</span></span>
                <input value={edits[key]} onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))} spellCheck={false} />
                <span className="env-state" />
                <button className="btn ghost btn-mini" onClick={() => setEdits((prev) => {
                  const next = { ...prev }
                  delete next[key]
                  return next
                })}>Discard</button>
              </li>
            ))}
          </ul>
        )}

        <div className="inline-form">
          <label className="field-block">
            <span className="field-block-label">New key</span>
            <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="FEATURE_FLAG" spellCheck={false} />
          </label>
          <label className="field-block">
            <span className="field-block-label">Value</span>
            <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="true" spellCheck={false} />
          </label>
          <button className="btn" disabled={!newKey.trim()} onClick={add}>
            <Glyph name="plus" size={13} />Add
          </button>
        </div>
        {note && <Notice tone="warn">{note}</Notice>}
      </Panel>
    </>
  )
}

// ── Database ─────────────────────────────────────────────────────────────

function DatabaseTab({ detail, busy, run, onNavigate }: {
  detail: Detail
  busy: string
  run: RunFn
  onNavigate: (tab: Tab) => void
}) {
  const current = detail.database
  const [driver, setDriver] = useState<DatabaseDriver>((current?.connection as DatabaseDriver) ?? 'sqlite')
  const [host, setHost] = useState(current?.host ?? '127.0.0.1')
  const [port, setPort] = useState(String(current?.port ?? 3306))
  const [database, setDatabase] = useState(current?.database ?? 'database/database.sqlite')
  const [username, setUsername] = useState(current?.username ?? '')
  const [password, setPassword] = useState('')
  const [create, setCreate] = useState(false)

  useEffect(() => {
    setDriver((current?.connection as DatabaseDriver) ?? 'sqlite')
    setHost(current?.host ?? '127.0.0.1')
    setPort(String(current?.port ?? defaultDatabasePort((current?.connection as DatabaseDriver) ?? 'sqlite')))
    setDatabase(current?.database ?? 'database/database.sqlite')
    setUsername(current?.username ?? '')
    setPassword('')
    setCreate(false)
  }, [current?.connection, current?.host, current?.port, current?.database, current?.username]) // eslint-disable-line react-hooks/exhaustive-deps

  const isSqlite = driver === 'sqlite'
  const portNumber = Number(port)
  const ready = isSqlite
    ? database.trim() !== ''
    : database.trim() !== '' && username.trim() !== '' && host.trim() !== '' && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535

  const save = () => {
    const input: SiteDatabaseInput = {
      connection: driver,
      host: host.trim(),
      port: portNumber,
      database: database.trim(),
      username: username.trim(),
      password: password === '' ? null : password,
      create: !isSqlite && create
    }
    void run('database', () => window.api.sites.setDatabase(detail.name, input))
  }

  return (
    <>
      {current ? (
        <div className="notice-stack">
          {current.reachable === true && <Notice tone="ok">The database answers with the credentials in <code>.env</code>.</Notice>}
          {current.reachable === false && <Notice tone="warn">The database is not reachable. {current.error}</Notice>}
          {current.reachable === null && current.error && <Notice tone="info">Connection test not available: {current.error}</Notice>}
        </div>
      ) : (
        <Notice tone="info">This project has no database settings in <code>.env</code> yet.</Notice>
      )}

      <Panel
        icon={<Glyph name="database" size={16} />}
        title="Connection"
        tag={current ? <span className="tag info">{DATABASE_LABELS[current.connection as DatabaseDriver] ?? current.connection}</span> : undefined}
      >
        <div className="inline-form">
          <label className="field-block">
            <span className="field-block-label">Driver</span>
            <select value={driver} onChange={(e) => {
              const next = e.target.value as DatabaseDriver
              setDriver(next)
              setPort(String(defaultDatabasePort(next)))
            }}>
              {(Object.keys(DATABASE_LABELS) as DatabaseDriver[]).map((d) => (
                <option key={d} value={d}>{DATABASE_LABELS[d]}</option>
              ))}
            </select>
          </label>
        </div>

        {isSqlite ? (
          <div className="form-row">
            <label className="field-block">
              <span className="field-block-label">SQLite file</span>
              <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="database/database.sqlite" spellCheck={false} />
            </label>
          </div>
        ) : (
          <div className="form-row">
            <label className="field-block"><span className="field-block-label">Host</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} /></label>
            <label className="field-block field-narrow"><span className="field-block-label">Port</span>
              <input value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} /></label>
            <label className="field-block"><span className="field-block-label">Database</span>
              <input value={database} onChange={(e) => setDatabase(e.target.value)} spellCheck={false} /></label>
            <label className="field-block"><span className="field-block-label">User</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} /></label>
            <label className="field-block"><span className="field-block-label">Password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder={current?.passwordSet ? 'Stored — write a new one to replace it' : 'No password'}
                autoComplete="new-password" /></label>
          </div>
        )}

        <label className="check">
          <input type="checkbox" checked={create} disabled={isSqlite} onChange={(e) => setCreate(e.target.checked)} />
          Create the database if it does not exist
        </label>

        <div className="panel-actions">
          <button className="btn primary" disabled={Boolean(busy) || !ready} onClick={save}>
            <Glyph name={busy === 'database' ? 'spinner' : 'check'} size={13} className={busy === 'database' ? 'spin' : ''} />
            Save connection
          </button>
          <button className="btn" onClick={() => onNavigate('database')}>Manage databases</button>
        </div>
        <p className="panel-note">
          Saving writes <code>DB_*</code> in the project&apos;s <code>.env</code> after backing it up.
          With <strong>Create</strong> checked, the panel asks the server for the database first; it
          never drops or overwrites an existing one.
        </p>
      </Panel>
    </>
  )
}

// ── Mail ─────────────────────────────────────────────────────────────────

function MailTab({ detail, busy, run, onNavigate }: {
  detail: Detail
  busy: string
  run: RunFn
  onNavigate: (tab: Tab) => void
}) {
  const current = detail.mail
  const [mailer, setMailer] = useState(current?.mailer ?? 'smtp')
  const [host, setHost] = useState(current?.host ?? '127.0.0.1')
  const [port, setPort] = useState(String(current?.port ?? 2525))
  const [username, setUsername] = useState(current?.username ?? detail.name)
  const [password, setPassword] = useState('')
  const [encryption, setEncryption] = useState(current?.encryption ?? '')

  useEffect(() => {
    setMailer(current?.mailer ?? 'smtp')
    setHost(current?.host ?? '127.0.0.1')
    setPort(String(current?.port ?? 2525))
    setUsername(current?.username ?? detail.name)
    setPassword('')
    setEncryption(current?.encryption ?? '')
  }, [current?.mailer, current?.host, current?.port, current?.username, current?.encryption, detail.name]) // eslint-disable-line react-hooks/exhaustive-deps

  const portNumber = Number(port)
  const ready = mailer.trim() !== '' && host.trim() !== '' && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535

  const save = () => {
    const input: SiteMailInput = {
      mailer: mailer.trim(),
      host: host.trim(),
      port: portNumber,
      username: username.trim(),
      password: password === '' ? null : password,
      encryption: encryption.trim()
    }
    void run('mail', () => window.api.sites.setMail(detail.name, input))
  }

  return (
    <>
      <Notice tone="info">
        The built-in catcher accepts any username and password. <code>MAIL_USERNAME</code> picks the
        inbox: messages from different projects stay apart, and mail sent without a username — or
        with <code>null</code> — lands in <code>default</code>. The password is never checked, so the
        panel writes <code>MAIL_PASSWORD=null</code>.
      </Notice>

      <Panel
        icon={<Glyph name="mail" size={16} />}
        title="Outgoing mail"
        tag={current ? <span className={`tag ${current.passwordSet ? 'on' : ''}`}>{current.username ? `user ${current.inbox}` : 'any credentials'}</span> : <span className="tag warn">not configured</span>}
      >
        <div className="form-row">
          <label className="field-block">
            <span className="field-block-label">Mailer</span>
            <select value={mailer} onChange={(e) => setMailer(e.target.value)}>
              {['smtp', 'log', 'array', 'sendmail', 'failover', 'roundrobin'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="field-block"><span className="field-block-label">Host</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} /></label>
          <label className="field-block field-narrow"><span className="field-block-label">Port</span>
            <input value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} /></label>
          <label className="field-block"><span className="field-block-label">Username</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} /></label>
          <label className="field-block"><span className="field-block-label">Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder={current?.passwordSet ? 'Stored — write a new one' : 'null'} autoComplete="new-password" /></label>
          <label className="field-block">
            <span className="field-block-label">Encryption</span>
            <select value={encryption} onChange={(e) => setEncryption(e.target.value)}>
              <option value="">none</option>
              <option value="tls">tls</option>
              <option value="ssl">ssl</option>
            </select>
          </label>
        </div>

        <div className="panel-actions">
          <button className="btn primary" disabled={Boolean(busy)} onClick={() => void run('mail', () => window.api.sites.applyMail(detail.name))}>
            <Glyph name={busy === 'mail' ? 'spinner' : 'mail'} size={13} className={busy === 'mail' ? 'spin' : ''} />
            Use built-in catcher
          </button>
          <button className="btn" disabled={Boolean(busy) || !ready} onClick={save}>
            <Glyph name="check" size={13} />Save SMTP settings
          </button>
          <button className="btn ghost" onClick={() => onNavigate('mail')}>Open Mail</button>
        </div>
        <p className="panel-note">
          <strong>Use built-in catcher</strong> writes the full SMTP block, including{' '}
          <code>MAIL_SCHEME</code> and <code>MAIL_ENCRYPTION</code> in sync. The username becomes the
          inbox in Mail, so this site&apos;s messages do not mix with the others.
        </p>

        {current && (
          <div className="mail-env">
            <div className="section-head">
              <h2>Laravel .env</h2>
              <span className="tag">ready to copy</span>
            </div>
            <CommandBlock commands={current.envBlock.split('\n')} />
            <p className="panel-note">
              Paste this block into the project&apos;s <code>.env</code>. It uses the saved values,
              including <code>MAIL_SCHEME=null</code> when encryption is off. The username picks the
              inbox in Mail; any password works.
            </p>
          </div>
        )}
      </Panel>
    </>
  )
}

// ── Queues ───────────────────────────────────────────────────────────────

function QueueTab({ detail, busy, run }: { detail: Detail; busy: string; run: RunFn }) {
  const current = detail.queue
  const [connection, setConnection] = useState(current.connection)
  const [queues, setQueues] = useState(current.queues)
  const [tries, setTries] = useState(String(current.tries))
  const [timeout, setTimeoutValue] = useState(String(current.timeout))
  const [sleep, setSleep] = useState(String(current.sleep))
  const [memory, setMemory] = useState(String(current.memory))
  const [workers, setWorkers] = useState(String(current.workers))
  const [scheduler, setScheduler] = useState(current.scheduler)
  const logs = useResource(() => window.api.queue.logs(detail.name))

  useEffect(() => {
    setConnection(current.connection)
    setQueues(current.queues)
    setTries(String(current.tries))
    setTimeoutValue(String(current.timeout))
    setSleep(String(current.sleep))
    setMemory(String(current.memory))
    setWorkers(String(current.workers))
    setScheduler(current.scheduler)
  }, [current.connection, current.queues, current.tries, current.timeout, current.sleep, current.memory, current.workers, current.scheduler])

  const isLaravel = detail.framework === 'laravel'
  const settings: Partial<SiteQueue> = {
    connection: connection.trim(),
    queues: queues.trim(),
    tries: numberOr(tries, current.tries),
    timeout: numberOr(timeout, current.timeout),
    sleep: numberOr(sleep, current.sleep),
    memory: numberOr(memory, current.memory),
    workers: numberOr(workers, current.workers),
    scheduler
  }

  const save = () => run('queue-save', () => window.api.sites.updateSettings(detail.name, { queue: settings }))

  const apply = () => run('queue-apply', async () => {
    await window.api.sites.updateSettings(detail.name, { queue: settings })
    await window.api.queue.apply(detail.name)
    return window.api.sites.detail(detail.name)
  })

  const stop = () => run('queue-stop', async () => {
    await window.api.queue.stop(detail.name)
    return window.api.sites.detail(detail.name)
  })

  return (
    <>
      {!isLaravel && <Notice tone="warn">This site is not a Laravel project: there is no <code>artisan</code> to run.</Notice>}
      {isLaravel && !current.systemd && <Notice tone="warn">systemd user services are not available in this session. Queues need a desktop session with systemd.</Notice>}

      <Panel
        icon={<Glyph name="services" size={16} />}
        title="Queue workers"
        tag={<span className={`tag ${current.units.some((u) => u.active) ? 'on' : ''}`}>{current.units.filter((u) => u.active).length}/{current.units.length} running</span>}
      >
        <div className="form-row">
          <label className="field-block"><span className="field-block-label">Connection</span>
            <input value={connection} onChange={(e) => setConnection(e.target.value)} placeholder="database" spellCheck={false} /></label>
          <label className="field-block"><span className="field-block-label">Queues</span>
            <input value={queues} onChange={(e) => setQueues(e.target.value)} placeholder="default,high" spellCheck={false} /></label>
          <label className="field-block field-narrow"><span className="field-block-label">Workers</span>
            <input value={workers} inputMode="numeric" onChange={(e) => setWorkers(e.target.value)} /></label>
          <label className="field-block field-narrow"><span className="field-block-label">Tries</span>
            <input value={tries} inputMode="numeric" onChange={(e) => setTries(e.target.value)} /></label>
          <label className="field-block field-narrow"><span className="field-block-label">Timeout (s)</span>
            <input value={timeout} inputMode="numeric" onChange={(e) => setTimeoutValue(e.target.value)} /></label>
          <label className="field-block field-narrow"><span className="field-block-label">Sleep (s)</span>
            <input value={sleep} inputMode="numeric" onChange={(e) => setSleep(e.target.value)} /></label>
          <label className="field-block field-narrow"><span className="field-block-label">Memory (MB)</span>
            <input value={memory} inputMode="numeric" onChange={(e) => setMemory(e.target.value)} /></label>
        </div>
        <label className="check">
          <input type="checkbox" checked={scheduler} onChange={(e) => setScheduler(e.target.checked)} />
          Run <code>php artisan schedule:work</code> for this site
        </label>

        <div className="panel-actions">
          <button className="btn primary" disabled={Boolean(busy) || !isLaravel} onClick={() => void apply()}>
            <Glyph name={busy === 'queue-apply' ? 'spinner' : 'play'} size={12} className={busy === 'queue-apply' ? 'spin' : ''} />
            Save and start
          </button>
          <button className="btn" disabled={Boolean(busy) || !isLaravel} onClick={() => void save()}>
            <Glyph name="check" size={13} />Save only
          </button>
          <button className="btn danger" disabled={Boolean(busy) || !isLaravel} onClick={() => void stop()}>
            <Glyph name="stop" size={12} />Stop all
          </button>
        </div>
        <p className="panel-note">
          Each worker is a user systemd unit (<code>systemctl --user</code>) that starts with your
          session and restarts on failure. It runs <code>queue:work</code> with the connection and
          queue names above, using the PHP version this site has isolated.
        </p>
      </Panel>

      {current.units.length > 0 && (
        <Panel icon={<Glyph name="services" size={16} />} title="Units" tag={<span className="tag">{current.units.length + (current.schedulerUnit ? 1 : 0)}</span>}>
          <ul className="mini-list">
            {current.units.map((unit) => (
              <li key={unit.unit}>
                <span className={`status-dot ${unit.active ? 'ok' : 'idle'}`} />
                <span className="mini-name"><code>{unit.unit}</code></span>
                <span className="tag">worker {unit.index}</span>
                <span className={`tag ${unit.active ? 'on' : ''}`}>{unit.active ? 'active' : 'stopped'}</span>
                {unit.enabled && <span className="tag info">enabled</span>}
              </li>
            ))}
            {current.schedulerUnit && (
              <li>
                <span className={`status-dot ${current.schedulerUnit.active ? 'ok' : 'idle'}`} />
                <span className="mini-name"><code>{current.schedulerUnit.unit}</code></span>
                <span className="tag">scheduler</span>
                <span className={`tag ${current.schedulerUnit.active ? 'on' : ''}`}>{current.schedulerUnit.active ? 'active' : 'stopped'}</span>
              </li>
            )}
          </ul>
        </Panel>
      )}

      <Panel
        icon={<Glyph name="terminal" size={16} />}
        title="Queue log"
        tag={
          <button className="btn ghost btn-mini" onClick={logs.reload} disabled={logs.loading}>
            <Glyph name="refresh" size={12} className={logs.loading ? 'spin' : ''} />Refresh
          </button>
        }
      >
        {logs.error && <Notice tone="warn">{logs.error}</Notice>}
        {logs.data !== undefined
          ? logs.data.trim()
            ? <pre className="log">{logs.data}</pre>
            : <p className="panel-note">No output yet. Start the workers and run a job.</p>
          : logs.error
            ? null
            : <RowsSkeleton rows={2} />}
        <p className="panel-note">Laravel&apos;s own log is in the <strong>Logs</strong> tab; this file only holds worker output.</p>
      </Panel>
    </>
  )
}

// ── Versions ─────────────────────────────────────────────────────────────

function VersionsTab({ detail, busy, run, onNavigate }: {
  detail: Detail
  busy: string
  run: RunFn
  onNavigate: (tab: Tab) => void
}) {
  const catalog = useResource(() => window.api.php.versions())
  const [phpVersion, setPhpVersion] = useState(detail.php.version)
  const [nodeVersion, setNodeVersion] = useState(detail.node.version)
  const [phpLog, setPhpLog] = useState('')
  const [phpDone, setPhpDone] = useState('')
  const [phpError, setPhpError] = useState('')
  const [phpInstalling, setPhpInstalling] = useState(false)

  useEffect(() => setPhpVersion(detail.php.version), [detail.php.version])
  useEffect(() => setNodeVersion(detail.node.version), [detail.node.version])
  useEffect(() => window.api.php.onInstallEvent((e) => {
    if (e.type === 'log') {
      setPhpLog((prev) => prev + e.text)
      return
    }
    setPhpInstalling(false)
    if (e.ok) {
      setPhpDone(e.message)
      setPhpError('')
      catalog.reload()
    } else {
      setPhpError(e.message)
      setPhpDone('')
    }
  }), [catalog.reload])

  const after = () => window.api.sites.detail(detail.name)
  const installed = detail.php.installed
  const options = useMemo(() => {
    const all = new Set<string>([
      ...installed,
      ...(catalog.data?.versions ?? []).filter((v) => v.installed).map((v) => v.version),
      ...(catalog.data?.available ?? []).map((v) => v.version),
      ...(detail.php.pinnedVersion ? [detail.php.pinnedVersion] : [])
    ])
    return [...all].sort((a, b) => compareVersions(b, a))
  }, [installed, catalog.data, detail.php.pinnedVersion])
  const selectedInstalled = installed.includes(phpVersion)
  const currentInfo = catalog.data?.versions.find((v) => v.version === detail.php.version)
  const pinnedMissing = detail.php.pinnedVersion !== null && !installed.includes(detail.php.pinnedVersion)

  const installAndIsolate = (version: string) => run('php', async () => {
    setPhpLog('')
    setPhpDone('')
    setPhpError('')
    if (!installed.includes(version)) {
      setPhpInstalling(true)
      await window.api.php.install(version)
    }
    await window.api.php.isolate(detail.name, version)
    return after()
  })

  return (
    <>
      <div className="dash-columns">
        <Panel
          icon={<Glyph name="php" size={16} />}
          title="PHP"
          tag={<SourceTag source={detail.php.source} />}
        >
          <dl className="kv">
            <div><dt>Version serving this site</dt><dd><strong>{detail.php.version || 'unknown'}</strong></dd></div>
            <div><dt>Own nginx config</dt><dd>{detail.php.isolatedFile ? <code>{detail.php.isolatedFile}</code> : 'follows the Valet default'}</dd></div>
            <div><dt>Project pin</dt><dd>{detail.php.pinnedFile ? <><code>{detail.php.pinnedFile}</code> → {detail.php.pinnedVersion}</> : 'none'}</dd></div>
            <div><dt>Installed on this machine</dt><dd>{installed.join(', ') || 'none detected'}</dd></div>
          </dl>
          {currentInfo?.updateAvailable && (
            <Notice tone="warn">
              PHP {detail.php.version} has a patch update: <strong>{currentInfo.patch ?? 'installed'}</strong>
              {' '}→ <strong>{currentInfo.latest}</strong>.
            </Notice>
          )}
          <div className="inline-form">
            <label className="field-block">
              <span className="field-block-label">Isolate this site on</span>
              <select value={phpVersion} onChange={(e) => setPhpVersion(e.target.value)}>
                {options.map((v) => (
                  <option key={v} value={v}>
                    PHP {v}{installed.includes(v) ? '' : ' (not installed)'}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn primary" disabled={Boolean(busy) || (phpVersion === detail.php.version && selectedInstalled)}
              onClick={() => void installAndIsolate(phpVersion)}>
              <Glyph name={busy === 'php' || phpInstalling ? 'spinner' : selectedInstalled ? 'check' : 'install'} size={13} className={busy === 'php' || phpInstalling ? 'spin' : ''} />
              {selectedInstalled ? (phpVersion === detail.php.version ? 'Isolated' : 'Isolate') : 'Install and isolate'}
            </button>
            {detail.php.source === 'isolated' && (
              <button className="btn" disabled={Boolean(busy)}
                onClick={() => void run('php', async () => { await window.api.php.isolate(detail.name, null); return after() })}>
                <Glyph name="restart" size={13} />Back to default
              </button>
            )}
            {currentInfo?.updateAvailable && (
              <button className="btn" disabled={Boolean(busy) || phpInstalling}
                onClick={() => void run('php', async () => {
                  setPhpInstalling(true)
                  await window.api.php.update(detail.php.version)
                  catalog.reload()
                  return after()
                })}>
                <Glyph name={phpInstalling ? 'spinner' : 'plus'} size={13} className={phpInstalling ? 'spin' : ''} />
                Update to {currentInfo.latest}
              </button>
            )}
          </div>
          <p className="panel-note">
            <code>valet isolate</code> writes a configuration just for this site. If the chosen
            version is not installed, the panel installs it first. Other sites keep using the
            default version.
          </p>
          <div className="panel-actions">
            {detail.php.pinnedVersion ? (
              <>
                <button className="btn" disabled={Boolean(busy)}
                  onClick={() => void installAndIsolate(detail.php.pinnedVersion as string)}>
                  <Glyph name="lock" size={13} />Apply project pin
                </button>
                <button className="btn ghost" disabled={Boolean(busy)}
                  onClick={() => void run('php-pin', async () => { await window.api.sites.pinPhp(detail.name, null); return after() })}>
                  <Glyph name="close" size={13} />Remove pin
                </button>
              </>
            ) : (
              <button className="btn" disabled={Boolean(busy) || !phpVersion}
                onClick={() => void run('php-pin', async () => { await window.api.sites.pinPhp(detail.name, phpVersion); return after() })}>
                <Glyph name="lock" size={13} />Pin PHP {phpVersion} in .flockrc
              </button>
            )}
            <button className="btn ghost" onClick={() => onNavigate('php')}>All PHP versions</button>
          </div>
          <p className="panel-note">
            The pin is stored in the project&apos;s <code>.flockrc</code> (<code>php={phpVersion}</code>),
            like Flock&apos;s. Valet ignores that file, so use <strong>Apply project pin</strong> to
            isolate the site as well.
          </p>
          {pinnedMissing && (
            <Notice tone="warn">The project pins PHP {detail.php.pinnedVersion}, but that version is not installed.</Notice>
          )}
          <TaskOutput text={phpLog} busy={phpInstalling} done={phpDone} error={phpError} />
        </Panel>

        <Panel
          icon={<Glyph name="terminal" size={16} />}
          title="Node.js"
          tag={<SourceTag source={detail.node.source} />}
        >
          <dl className="kv">
            <div><dt>Version for this site</dt><dd><strong>{detail.node.version || 'unknown'}</strong></dd></div>
            <div><dt>Project file</dt><dd>{detail.node.pinnedFile ? `${detail.node.pinnedFile} → ${detail.node.pinnedVersion}` : 'none'}</dd></div>
            <div><dt>Installed with nvm</dt><dd>{detail.node.installed.join(', ') || 'none detected'}</dd></div>
          </dl>
          <div className="inline-form">
            <label className="field-block">
              <span className="field-block-label">Panel version</span>
              <select value={nodeVersion} onChange={(e) => setNodeVersion(e.target.value)}>
                {detail.node.installed.map((v) => <option key={v} value={v}>Node {v}</option>)}
              </select>
            </label>
            <button className="btn primary" disabled={Boolean(busy) || nodeVersion === detail.node.version}
              onClick={() => void run('node', async () => {
                await window.api.sites.updateSettings(detail.name, { node: nodeVersion })
                return after()
              })}>
              <Glyph name="check" size={13} />Use in panel
            </button>
            <button className="btn" disabled={Boolean(busy)}
              onClick={() => void run('node', async () => {
                await window.api.sites.updateSettings(detail.name, { node: null })
                return after()
              })}>
              <Glyph name="restart" size={13} />Automatic
            </button>
          </div>
          <div className="panel-actions">
            <button className="btn" disabled={Boolean(busy) || !nodeVersion}
              onClick={() => void run('node-pin', async () => {
                await window.api.node.pin(detail.name, nodeVersion)
                return after()
              })}>
              <Glyph name="lock" size={13} />Write .nvmrc
            </button>
            {detail.node.pinnedFile === '.nvmrc' && (
              <button className="btn danger" disabled={Boolean(busy)}
                onClick={() => void run('node-pin', async () => {
                  await window.api.node.unpin(detail.name)
                  return after()
                })}>
                <Glyph name="close" size={13} />Remove .nvmrc
              </button>
            )}
            <button className="btn ghost" onClick={() => onNavigate('node')}>All Node versions</button>
          </div>
          <p className="panel-note">
            The panel version is stored in <code>~/.valet-studio/sites/{detail.name}.json</code>.
            <strong> Write .nvmrc</strong> makes the same choice visible to nvm and every editor.
          </p>
        </Panel>
      </div>
    </>
  )
}

// ── Logs ─────────────────────────────────────────────────────────────────

function LogsTab({ detail, onRefresh }: { detail: Detail; onRefresh: () => void }) {
  const laravel = detail.logs.laravel
  return (
    <>
      <Panel
        icon={<Glyph name="terminal" size={16} />}
        title="Laravel log"
        tag={<button className="btn ghost btn-mini" onClick={onRefresh}><Glyph name="refresh" size={12} />Refresh</button>}
      >
        {laravel.file
          ? (
            <>
              <p className="panel-note"><code>{laravel.file}</code> · {formatBytes(laravel.size)}</p>
              {laravel.text.trim()
                ? <pre className="log">{laravel.text}</pre>
                : <p className="panel-note">The file is empty.</p>}
            </>
          )
          : <p className="panel-note">No <code>storage/logs/*.log</code> yet. Laravel creates one on the first error.</p>}
      </Panel>
      <Panel icon={<Glyph name="terminal" size={16} />} title="Queue log">
        {detail.logs.queue.file
          ? (
            <>
              <p className="panel-note"><code>{detail.logs.queue.file}</code> · {formatBytes(detail.logs.queue.size)}</p>
              {detail.logs.queue.text.trim()
                ? <pre className="log">{detail.logs.queue.text}</pre>
                : <p className="panel-note">No worker output yet.</p>}
            </>
          )
          : <p className="panel-note">Start the queue workers to create this log.</p>}
      </Panel>
    </>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────

export function SiteDetail({ name, onClose, onNavigate, onSitesChanged }: {
  name: string
  onClose: () => void
  onNavigate: (tab: Tab) => void
  onSitesChanged: () => void
}) {
  const r = useResource(() => window.api.sites.detail(name), Boolean(name))
  const [detail, setDetail] = useState<Detail>()
  const [tab, setTab] = useState<DetailTab>('overview')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => { if (r.data) setDetail(r.data) }, [r.data])
  useEffect(() => { setDetail(undefined); setTab('overview'); setError('') }, [name])

  const run: RunFn = async (label, fn) => {
    setBusy(label)
    setError('')
    try {
      const next = await fn()
      if (next) setDetail(next)
      onSitesChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const refresh = () => {
    void run('refresh', async () => window.api.sites.detail(name))
  }

  return (
    <Page
      title={detail?.name ?? name}
      hint={detail ? `${detail.path} · ${detail.framework === 'laravel' ? 'Laravel project' : detail.framework === 'php' ? 'PHP project' : 'static files'}` : 'Loading site details…'}
      error={r.error || error}
      loading={r.loading}
      onRefresh={refresh}
      actions={
        <button className="btn" onClick={onClose}>
          <Glyph name="chevron" size={12} className="flip-x" />All sites
        </button>
      }
    >
      {r.loading && !detail && <RowsSkeleton rows={5} />}
      {detail && (
        <>
          <nav className="tabs" role="tablist" aria-label="Site sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? 'on' : ''}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === 'queue' && detail.queue.units.some((u) => u.active) && <span className="tab-dot" />}
              </button>
            ))}
          </nav>

          {tab === 'overview' && <OverviewTab detail={detail} busy={busy} run={run} onNavigate={onNavigate} />}
          {tab === 'env' && <EnvTab detail={detail} busy={busy} run={run} />}
          {tab === 'database' && <DatabaseTab detail={detail} busy={busy} run={run} onNavigate={onNavigate} />}
          {tab === 'mail' && <MailTab detail={detail} busy={busy} run={run} onNavigate={onNavigate} />}
          {tab === 'queue' && <QueueTab detail={detail} busy={busy} run={run} />}
          {tab === 'versions' && <VersionsTab detail={detail} busy={busy} run={run} onNavigate={onNavigate} />}
          {tab === 'logs' && <LogsTab detail={detail} onRefresh={refresh} />}
        </>
      )}
    </Page>
  )
}
