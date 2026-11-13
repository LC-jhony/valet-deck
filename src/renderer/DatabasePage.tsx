// Bases de datos del equipo. Cada motor es una tarjeta con su estado real,
// sus bases y unas credenciales que el panel guarda cifradas por permisos
// (0600). Las contraseñas nunca se devuelven: solo se escriben.

import { useEffect, useState } from 'react'
import type { DatabaseEntry, DatabaseServer } from '../shared/site'
import { databaseEnv, databaseGuide, type GuidePm } from '../shared/database-guides'
import type { Tab } from './nav'
import {
  EmptyState, Notice, Panel, Page, RowsSkeleton, Seg, formatBytes, useAction, type Resource
} from './ui'
import { CommandBlock } from './CommandBlock'
import { Glyph } from './ui-icons'
import type { DatabasesInfo } from '../shared/site'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
const PM_OPTIONS: [GuidePm, string][] = [['apt', 'apt · Ubuntu'], ['dnf', 'dnf · Fedora'], ['pacman', 'pacman · Arch']]

function GuideBody({ engine, server }: { engine: DatabaseServer['engine']; server: DatabaseServer | null }) {
  const [pm, setPm] = useState<GuidePm>('apt')
  const guide = databaseGuide(engine)
  return (
    <>
      <p className="panel-note">{guide.summary}</p>
      <Seg label="Package manager" value={pm} options={PM_OPTIONS} onChange={setPm} />
      {guide.steps[pm].map((step) => (
        <div className="guide-step" key={`${engine}-${pm}-${step.label}`}>
          <h3>{step.label}</h3>
          <CommandBlock commands={step.commands} />
        </div>
      ))}
      <div className="guide-step">
        <h3>Laravel <code>.env</code></h3>
        <CommandBlock commands={databaseEnv(engine, server)} />
        {engine === 'sqlite'
          ? <p className="panel-note">Replace the path with the absolute path to your project&apos;s SQLite file.</p>
          : (
            <p className="panel-note">
              Replace <code>my_app</code> with your database and <code>change-me</code> with the password
              you set. The panel never returns a stored password to this window.
            </p>
          )}
      </div>
      {guide.notes.length > 0 && (
        <ul className="guide-notes">
          {guide.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </>
  )
}

function ServerCard({ server, onChanged }: { server: DatabaseServer; onChanged: () => void }) {
  const a = useAction(onChanged)
  const [host, setHost] = useState(server.host)
  const [port, setPort] = useState(String(server.port))
  const [username, setUsername] = useState(server.username)
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [confirming, setConfirming] = useState('')
  const [tested, setTested] = useState('')
  const [testError, setTestError] = useState('')

  useEffect(() => {
    setHost(server.host)
    setPort(String(server.port))
    setUsername(server.username)
  }, [server.host, server.port, server.username])

  const portNumber = Number(port)
  const ready = host.trim() !== '' && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535 && username.trim() !== ''
  const engine = server.engine

  const save = () => a.act(() => window.api.databases.saveCredentials({
    engine, host: host.trim(), port: portNumber, username: username.trim(), password
  }))

  const test = async () => {
    setTested('')
    setTestError('')
    try {
      await window.api.databases.test({
        engine, host: host.trim(), port: portNumber, username: username.trim(), password
      })
      setTested('Connection works.')
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e))
    }
  }

  const create = async () => {
    setTestError('')
    if (!NAME_RE.test(name.trim())) {
      setTestError('Use letters, numbers, hyphens or underscores. The name starts with a letter or number.')
      return
    }
    await a.act(async () => {
      await window.api.databases.create(engine, name.trim())
      setName('')
    })
  }

  const drop = async (db: DatabaseEntry) => {
    if (confirming !== db.name) {
      setConfirming(db.name)
      return
    }
    setConfirming('')
    await a.act(() => window.api.databases.drop(engine, db.name))
  }

  return (
    <Panel
      icon={<Glyph name="database" size={16} />}
      title={server.label}
      tag={
        <>
          {server.version && <span className="tag">v{server.version}</span>}
          <span className={`tag ${server.active ? 'on' : 'warn'}`}>{server.active ? 'running' : 'stopped'}</span>
        </>
      }
    >
      {server.error && <Notice tone="warn">{server.error}</Notice>}

      <dl className="kv">
        <div><dt>Server</dt><dd><code>{server.host}:{server.port}</code></dd></div>
        <div><dt>User</dt><dd>{server.username || 'not configured'} {server.managed && <span className="tag on">saved</span>}</dd></div>
        <div><dt>Databases</dt><dd>{server.databases.length}</dd></div>
      </dl>

      {!server.active && (
        <div className="panel-actions">
          <button
            className="btn primary"
            disabled={a.busy}
            onClick={() => void a.act(() => window.api.services.action(server.service, 'start'))}
          >
            <Glyph name={a.busy ? 'spinner' : 'play'} size={13} className={a.busy ? 'spin' : ''} />
            Start {server.label}
          </button>
        </div>
      )}

      <details className="details-block">
        <summary>Connection settings</summary>
        <div className="form-row">
          <label className="field-block"><span className="field-block-label">Host</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} /></label>
          <label className="field-block field-narrow"><span className="field-block-label">Port</span>
            <input value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} /></label>
          <label className="field-block"><span className="field-block-label">User</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} /></label>
          <label className="field-block"><span className="field-block-label">Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder={server.managed ? 'Stored — write a new one to replace it' : 'No password'} autoComplete="new-password" /></label>
        </div>
        <div className="panel-actions">
          <button className="btn primary" disabled={a.busy || !ready} onClick={() => void save()}>
            <Glyph name="check" size={13} />Save
          </button>
          <button className="btn" disabled={a.busy || !ready} onClick={() => void test()}>
            <Glyph name="play" size={12} />Test connection
          </button>
        </div>
        {tested && <Notice tone="ok">{tested}</Notice>}
        {testError && <Notice tone="warn">{testError}</Notice>}
        <p className="panel-note">
          The panel stores these credentials in <code>~/.valet-studio/databases.json</code> with
          permissions 0600. They are only used from the process that runs the queries; the window
          never receives the stored password.
        </p>
      </details>

      <details className="details-block guide-block">
        <summary>Install and connect {server.label}</summary>
        <GuideBody engine={engine} server={server} />
      </details>

      {server.databases.length > 0 && (
        <ul className="rows rows-flat">
          {server.databases.map((db) => (
            <li key={db.name}>
              <div className="row-main">
                <span className="row-icon"><Glyph name="database" size={16} /></span>
                <div className="row-text">
                  <strong>{db.name}</strong>
                  <small>
                    {formatBytes(db.size)}
                    {db.tables != null && ` · ${db.tables} ${db.tables === 1 ? 'table' : 'tables'}`}
                    {db.charset && ` · ${db.charset}`}
                  </small>
                </div>
              </div>
              {db.sites.length > 0 && (
                <div className="row-meta">
                  {db.sites.map((s) => <span key={s} className="tag">{s}</span>)}
                </div>
              )}
              <div className="row-actions">
                <button
                  className={`btn ${confirming === db.name ? 'danger' : ''}`}
                  disabled={a.busy}
                  onClick={() => void drop(db)}
                  onBlur={() => { if (confirming === db.name) setConfirming('') }}
                >
                  <Glyph name={confirming === db.name ? 'alert' : 'close'} size={13} />
                  {confirming === db.name ? 'Confirm drop' : 'Drop'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="inline-form">
        <label className="field-block">
          <span className="field-block-label">New database</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my_app"
            onKeyDown={(e) => { if (e.key === 'Enter' && !a.busy) void create() }} spellCheck={false} />
        </label>
        <button className="btn" disabled={a.busy || name.trim() === ''} onClick={() => void create()}>
          <Glyph name="plus" size={13} />Create
        </button>
      </div>
      <p className="panel-note">
        The name is validated before reaching the server. Dropping a database asks for a second
        click and cannot be undone.
      </p>
    </Panel>
  )
}

export function DatabasePage({ r, onNavigate }: { r: Resource<DatabasesInfo>; onNavigate: (tab: Tab) => void }) {
  const info = r.data
  const installed = info ? info.servers.filter((s) => s.installed) : []
  const missing = info ? info.servers.filter((s) => !s.installed) : []
  const active = info ? info.servers.filter((s) => s.active) : []
  const total = info ? info.servers.reduce((sum, s) => sum + s.databases.length, 0) : 0

  return (
    <Page
      title="Databases"
      hint="MariaDB, MySQL, PostgreSQL and the SQLite files that belong to your sites."
      error={r.error}
      loading={r.loading}
      onRefresh={r.reload}
      actions={
        <button className="btn" onClick={() => onNavigate('services')}>
          <Glyph name="services" size={14} />Services
        </button>
      }
    >
      {r.loading && !info && <RowsSkeleton rows={4} />}
      {info && (
        <>
          <div className="metric-grid metric-grid-3">
            <div className="metric">
              <span className="metric-top"><span className="metric-label">Engines</span><span className="metric-icon"><Glyph name="database" size={18} /></span></span>
              <strong className="metric-value">{installed.length}</strong>
              <span className="metric-detail">{active.length} running right now.</span>
            </div>
            <div className="metric">
              <span className="metric-top"><span className="metric-label">SQL databases</span><span className="metric-icon"><Glyph name="database" size={18} /></span></span>
              <strong className="metric-value">{total}</strong>
              <span className="metric-detail">Across every managed server.</span>
            </div>
            <div className="metric">
              <span className="metric-top"><span className="metric-label">SQLite files</span><span className="metric-icon"><Glyph name="sites" size={18} /></span></span>
              <strong className="metric-value">{info.sqlite.length}</strong>
              <span className="metric-detail">Used by sites with <code>DB_CONNECTION=sqlite</code>.</span>
            </div>
          </div>

          {installed.length === 0 && (
            <EmptyState icon="services" title="No database engine installed">
              Install MariaDB, MySQL or PostgreSQL from your package manager. The panel detects it
              automatically; you can also check the <strong>Services</strong> page.
            </EmptyState>
          )}

          {info.servers.filter((s) => s.installed).map((server) => (
            <ServerCard key={server.engine} server={server} onChanged={r.reload} />
          ))}

          {missing.length > 0 && (
            <Panel
              icon={<Glyph name="install" size={16} />}
              title="Other database engines"
              tag={<span className="tag">{missing.length} not installed</span>}
            >
              <p className="panel-note">
                These are not installed on this machine, so the panel does not try to connect to
                them or report them as stopped. Open a guide to install one; it will appear here
                automatically.
              </p>
              {missing.map((server) => (
                <details className="details-block guide-block" key={server.engine}>
                  <summary>Install and connect {server.label}</summary>
                  <GuideBody engine={server.engine} server={server} />
                </details>
              ))}
            </Panel>
          )}

          <Panel
            icon={<Glyph name="sites" size={16} />}
            title="SQLite files"
            tag={<span className="tag">{info.sqlite.length}</span>}
          >
            {info.sqlite.length === 0
              ? <EmptyState icon="sites" title="No SQLite files found">Laravel creates <code>database/database.sqlite</code> when you choose SQLite.</EmptyState>
              : (
                <ul className="rows rows-flat">
                  {info.sqlite.map((file) => (
                    <li key={file.file}>
                      <div className="row-main">
                        <span className="row-icon"><Glyph name="database" size={16} /></span>
                        <div className="row-text"><strong>{file.site}</strong><small>{file.file}</small></div>
                      </div>
                      <div className="row-meta"><span className="tag">{formatBytes(file.size)}</span></div>
                    </li>
                  ))}
                </ul>
              )}
            <details className="details-block guide-block">
              <summary>Install and connect SQLite</summary>
              <GuideBody engine="sqlite" server={null} />
            </details>
            <p className="panel-note">
              SQLite databases are plain files owned by the project. The panel shows where they are
              but does not modify them; use <strong>Open folder</strong> on the site to reach them.
            </p>
          </Panel>
        </>
      )}
    </Page>
  )
}
