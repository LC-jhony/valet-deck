// Versiones de PHP del equipo. El panel no inventa un catálogo: enseña lo que
// hay instalado, cuál sirve Valet y qué sitios están aislados en cada una.
// Instalar y actualizar usan apt y muestran la salida en vivo porque puede
// tardar minutos.

import { useEffect, useState } from 'react'
import type { PhpVersionInfo } from '../shared/site'
import { CommandBlock } from './CommandBlock'
import { EmptyState, Notice, Panel, Page, RowsSkeleton, TaskOutput, formatBytes, useAction, useResource } from './ui'
import { Glyph } from './ui-icons'

export function PhpVersions({ onChanged }: { onChanged: () => void }) {
  const r = useResource(() => window.api.php.versions())
  const a = useAction(r.reload)
  const [installing, setInstalling] = useState('')
  const [log, setLog] = useState('')
  const [done, setDone] = useState('')
  const [installError, setInstallError] = useState('')
  const [logOpen, setLogOpen] = useState('')
  const [logText, setLogText] = useState('')
  const [logLoading, setLogLoading] = useState(false)

  useEffect(() => window.api.php.onInstallEvent((e) => {
    if (e.type === 'log') {
      setLog((prev) => prev + e.text)
      return
    }
    setInstalling('')
    if (e.ok) {
      setDone(e.message)
      setInstallError('')
      r.reload()
      onChanged()
    } else {
      setInstallError(e.message)
      setDone('')
      r.reload()
    }
  }), [r.reload, onChanged])

  const info = r.data
  const runInstall = async (version: string, action: 'install' | 'update') => {
    setInstalling(version)
    setLog('')
    setDone('')
    setInstallError('')
    try {
      if (action === 'update') await window.api.php.update(version)
      else await window.api.php.install(version)
    } catch {
      // El evento `done` ya trae el motivo; la promesa solo confirma el fallo.
    }
  }

  const cancel = async (version: string) => {
    setInstallError('')
    try {
      await window.api.php.cancel(version)
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = (v: PhpVersionInfo) => {
    if (!confirm(
      `Remove PHP ${v.version} and its extensions? This runs apt purge and cannot be undone.`
    )) return
    setInstalling(v.version)
    setLog('')
    setDone('')
    setInstallError('')
    void window.api.php.uninstall(v.version).catch(() => {
      // El evento `done` ya trae el motivo.
    })
  }

  const openLog = async (version: string) => {
    setLogOpen(version)
    setLogText('')
    setLogLoading(true)
    try {
      setLogText(await window.api.php.installLog(version))
    } finally {
      setLogLoading(false)
    }
  }

  const card = (v: PhpVersionInfo) => {
    const sites = v.sites
    const job = v.job
    return (
      <li key={v.version}>
        <div className="row-main">
          <span className="row-icon"><Glyph name="php" size={18} /></span>
          <div className="row-text">
            <strong>PHP {v.version}</strong>
            <small>
              {v.patch ? `${v.patch} installed` : 'No php.ini'}
              {v.latest && ` · latest ${v.latest}`}
              {v.size != null && ` · ${formatBytes(v.size)}${v.sizeKind === 'download' ? ' to download' : ' on disk'}`}
              {v.extensions.length > 0 && ` · ${v.extensions.length} extensions`}
            </small>
          </div>
        </div>
        <div className="row-meta">
          {v.isDefault && <span className="tag on">Valet default</span>}
          {v.installed
            ? <span className={`tag ${v.fpmActive ? 'on' : 'warn'}`}>FPM {v.fpmActive ? 'running' : 'stopped'}</span>
            : <span className="tag warn">not installed</span>}
          {v.xdebug && <span className="tag info">Xdebug</span>}
          {v.updateAvailable && <span className="tag warn">update {v.latest}</span>}
          {job?.state === 'running' && <span className="tag info">{job.phase}…</span>}
          {job?.state === 'failed' && <span className="tag warn" title={job.error}>last job failed</span>}
          {sites.length > 0 && <span className="tag info">{sites.length} {sites.length === 1 ? 'site' : 'sites'}</span>}
        </div>
        <div className="row-actions">
          {!v.installed && (
            <button className="btn primary" disabled={Boolean(installing)} onClick={() => void runInstall(v.version, 'install')}>
              <Glyph name={installing === v.version ? 'spinner' : 'install'} size={13} className={installing === v.version ? 'spin' : ''} />
              {installing === v.version ? 'Installing…' : 'Install'}
            </button>
          )}
          {v.installed && v.updateAvailable && (
            <button className="btn primary" disabled={Boolean(installing)} onClick={() => void runInstall(v.version, 'update')}>
              <Glyph name={installing === v.version ? 'spinner' : 'plus'} size={13} className={installing === v.version ? 'spin' : ''} />
              {installing === v.version ? 'Updating…' : `Update to ${v.latest}`}
            </button>
          )}
          <button
            className="btn"
            disabled={a.busy || !v.installed || v.isDefault}
            title={v.isDefault ? 'Already the version Valet serves' : `Serve ${v.version} by default`}
            onClick={() => a.act(async () => { await window.api.php.use(v.version); onChanged() })}
          >
            <Glyph name="check" size={13} />
            {v.isDefault ? 'In use' : 'Use as default'}
          </button>
          {v.installed && !v.isDefault && sites.length === 0 && v.job?.state !== 'running' && (
            <button
              className="btn danger"
              disabled={Boolean(installing)}
              title={`Remove PHP ${v.version} with apt purge`}
              onClick={() => remove(v)}
            >
              <Glyph name="trash" size={13} />
              {installing === v.version ? 'Removing…' : 'Remove'}
            </button>
          )}
          {job?.state === 'running' && (
            <button className="btn" onClick={() => void cancel(v.version)}>
              <Glyph name="close" size={13} />Cancel
            </button>
          )}
          {(v.logFile || job) && (
            <button className="btn ghost" onClick={() => void openLog(v.version)}>
              <Glyph name="terminal" size={13} />Log
            </button>
          )}
        </div>
        {job?.state === 'failed' && (
          <div className="row-wide"><span className="muted">{job.error}</span></div>
        )}
        {sites.length > 0 && (
          <div className="row-wide">
            <span className="muted">Isolated sites:</span>
            {sites.map((s) => <span key={s} className="tag">{s}</span>)}
          </div>
        )}
      </li>
    )
  }

  return (
    <Page
      title="PHP versions"
      hint="Install a version, update its patch release, choose the one Valet serves by default and see which sites are isolated."
      error={r.error || a.error}
      loading={r.loading}
      onRefresh={r.reload}
    >
      {r.loading && !info && <RowsSkeleton rows={3} />}
      {info && (
        <>
          <div className="metric-grid metric-grid-3">
            <div className="metric">
              <span className="metric-top"><span className="metric-label">Served by Valet</span><span className="metric-icon"><Glyph name="php" size={18} /></span></span>
              <strong className="metric-value">{info.defaultVersion || '—'}</strong>
              <span className="metric-detail">The socket <code>~/.valet/valet.sock</code> points at it.</span>
            </div>
            <div className="metric">
              <span className="metric-top"><span className="metric-label">Installed</span><span className="metric-icon"><Glyph name="services" size={18} /></span></span>
              <strong className="metric-value">{info.versions.filter((v) => v.installed).length}</strong>
              <span className="metric-detail">Versions found in <code>/etc/php</code> or <code>/usr/bin</code>.</span>
            </div>
            <div className="metric">
              <span className="metric-top"><span className="metric-label">Command line</span><span className="metric-icon"><Glyph name="terminal" size={18} /></span></span>
              <strong className="metric-value">{info.currentCli || '—'}</strong>
              <span className="metric-detail">What <code>php -v</code> reports.</span>
            </div>
          </div>

          {info.warning && <Notice tone="warn">{info.warning}</Notice>}

          <Panel
            icon={<Glyph name="install" size={16} />}
            title="PHP repository"
            tag={
              <>
                <span className="tag">{info.repo.label}</span>
                {info.repo.kind && (
                  <span className={`tag ${info.repo.enabled ? 'on' : 'warn'}`}>
                    {info.repo.enabled ? 'configured' : 'not configured'}
                  </span>
                )}
              </>
            }
          >
            <dl className="kv">
              <div><dt>Source</dt><dd>{info.repo.label}</dd></div>
              {info.repo.suite && <div><dt>Suite</dt><dd><code>{info.repo.suite}</code></dd></div>}
              <div>
                <dt>Status</dt>
                <dd>
                  {info.repo.kind
                    ? info.repo.enabled
                      ? 'apt already reads this repository.'
                      : 'apt does not read this repository yet.'
                    : 'PHP comes from the distribution repositories.'}
                </dd>
              </div>
            </dl>
            {info.repo.note && <Notice tone="info">{info.repo.note}</Notice>}
            {info.repo.stale && (
              <Notice tone="warn">
                A Sury PHP repository from an older Ubuntu release is still configured. Its
                packages need libraries this release no longer ships, so apt cannot resolve PHP
                until it is removed. The next install or update removes it and keeps a copy in{' '}
                <code>~/.valet-studio/backups/apt</code>.
              </Notice>
            )}
            {info.repo.commands.length > 0 && (
              <details className="details-block">
                <summary>Commands to add it by hand</summary>
                <CommandBlock commands={info.repo.commands} />
              </details>
            )}
            <div className="panel-actions">
              {info.repo.kind && !info.repo.enabled && (
                <button className="btn primary" disabled={a.busy || Boolean(installing)} onClick={() => void a.act(() => window.api.php.addRepo())}>
                  <Glyph name={a.busy ? 'spinner' : 'plus'} size={13} className={a.busy ? 'spin' : ''} />
                  Add the PHP repository
                </button>
              )}
              {info.repo.kind && info.repo.enabled && (
                <span className="tag on"><Glyph name="check" size={11} />apt is using it</span>
              )}
            </div>
            <p className="panel-note">
              Supported Ubuntu LTS releases use the Ondřej PHP PPA; interim releases before 26.04
              use packages.sury.org. From Ubuntu 26.04 the distribution already ships PHP 8.5, so
              the panel uses it and does not add Sury. Debian and releases without a PHP repository
              use the distribution PHP. Adding the repository asks for the administrator password
              and only writes apt sources; installing a version stays a separate action.
            </p>
          </Panel>

          <Panel icon={<Glyph name="php" size={16} />} title="Installed versions">
            {info.versions.length === 0
              ? <EmptyState icon="php" title="No PHP versions found">Install one below, or use your distribution packages.</EmptyState>
              : <ul className="rows rows-flat">{info.versions.map(card)}</ul>}
          </Panel>

          <Panel
            icon={<Glyph name="install" size={16} />}
            title="PHP versions"
            tag={<span className="tag">{info.available.filter((v) => v.installable).length} installable</span>}
          >
            {info.available.length === 0
              ? (
                <p className="panel-note">
                  Every version your package manager offers is already installed. New versions come
                  from the PHP repository configured above.
                </p>
              )
              : (
                <>
                  <ul className="rows rows-flat">
                    {info.available.map((entry) => (
                      <li key={entry.version}>
                        <div className="row-main">
                          <span className="row-icon"><Glyph name="php" size={18} /></span>
                          <div className="row-text">
                            <strong>PHP {entry.version}</strong>
                            <small>
                              {entry.installable
                                ? <>
                                    {entry.latest ? `Latest ${entry.latest}` : `php${entry.version}-fpm and common extensions`}
                                    {entry.size != null && ` · ${formatBytes(entry.size)} to download`}
                                  </>
                                : entry.reason}
                            </small>
                          </div>
                        </div>
                        <div className="row-meta">
                          {entry.installable
                            ? <span className="tag on">available</span>
                            : <span className="tag">not available</span>}
                        </div>
                        <div className="row-actions">
                          <button
                            className="btn primary"
                            disabled={Boolean(installing) || !entry.installable}
                            title={entry.installable ? undefined : entry.reason}
                            onClick={() => void runInstall(entry.version, 'install')}
                          >
                            <Glyph name={installing === entry.version ? 'spinner' : 'plus'} size={13} className={installing === entry.version ? 'spin' : ''} />
                            {installing === entry.version ? 'Installing…' : 'Install'}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="panel-note">
                    The list shows every version this panel knows about, including the ones your
                    configured repositories do not publish for this Ubuntu release. Installation runs
                    <code>apt-get</code> with the same timeouts and English output as the main
                    installer. It asks for your administrator password and keeps every other PHP
                    version untouched. Updates install the newest patch release of the same minor.
                  </p>
                </>
              )}
          </Panel>

          <TaskOutput text={log} busy={Boolean(installing)} done={done} error={installError} />

          {logOpen && (
            <Panel
              icon={<Glyph name="terminal" size={16} />}
              title={`PHP ${logOpen} install log`}
              tag={<button className="btn ghost btn-mini" onClick={() => setLogOpen('')}><Glyph name="close" size={12} />Close</button>}
            >
              {logLoading
                ? <RowsSkeleton rows={2} />
                : logText.trim()
                  ? <pre className="log">{logText}</pre>
                  : <p className="panel-note">No install log for PHP {logOpen} yet.</p>}
            </Panel>
          )}

          <p className="panel-note">
            Isolating a site lives in <strong>Sites → PHP &amp; Node.js</strong>: Valet writes a small
            nginx configuration for that site only, so the rest keep the default version.
          </p>
        </>
      )}
    </Page>
  )
}
