// Vista general del entorno. No repite el listado de cada página: resume lo
// que está vivo, lo que falta y dónde se arregla, con atajos a la sección
// concreta. Los avisos se muestran antes que los números porque son lo único
// que requiere una decisión.

import { useState } from 'react'
import type { DashboardInfo } from '../shared/site'
import type { Tab } from './nav'
import type { Resource } from './ui'
import { EmptyState, Metric, Notice, Panel, Page, RowsSkeleton, useAction } from './ui'
import { Glyph } from './ui-icons'

/** Nombre corto del servicio que bloquea los puertos: «Flock (unidad)» → «Flock». */
const holderName = (process: string) => process.replace(/\s*\([^)]*\)\s*$/, '').trim() || process

/**
 * Estado de Valet en una sola línea: en marcha o no, con el motivo y la acción
 * que lo resuelve. Si otro servidor local (Flock) ocupa 80/443, no se presenta
 * como «nginx roto»: se nombra al dueño y se ofrece pararlo de forma explícita,
 * porque hacerlo afecta a ese otro entorno.
 */
function ValetStatus({ web, phpVersion, onChanged, onNavigate }: {
  web: DashboardInfo['web']
  phpVersion: string
  onChanged: () => void
  onNavigate: (tab: Tab) => void
}) {
  const a = useAction(onChanged)
  const [keepOff, setKeepOff] = useState(false)

  if (web.conflict) {
    const name = holderName(web.conflict.process)
    const ports = web.conflict.ports.join(' and ')
    return (
      <section className="valet-state is-blocked" aria-live="polite">
        <span className="valet-state-icon"><Glyph name="alert" size={18} /></span>
        <div className="valet-state-copy">
          <strong>{name} is using ports {ports}</strong>
          <p>
            Valet&apos;s nginx cannot start while {name} runs, so sites will not open through
            Valet. Stop {name} to let nginx take the ports.
          </p>
          {web.conflict.enabled && (
            <small>{name} starts at boot, so it will take the ports again after a restart.</small>
          )}
          {a.error && <Notice tone="warn">{a.error}</Notice>}
        </div>
        <div className="valet-state-actions">
          <label className="check valet-state-check">
            <input type="checkbox" checked={keepOff} onChange={(e) => setKeepOff(e.target.checked)} />
            Keep it off at boot
          </label>
          <button
            className="btn primary"
            disabled={a.busy}
            onClick={() => {
              const boot = keepOff ? ' It will stay off at boot too.' : ''
              if (!confirm(`Stop ${name} and start nginx? ${name} will stop serving until you start it again.${boot}`)) return
              void a.act(() => window.api.system.freeWebPorts(keepOff))
            }}
          >
            <Glyph name={a.busy ? 'spinner' : 'play'} size={13} className={a.busy ? 'spin' : ''} />
            Stop {name} and start nginx
          </button>
        </div>
      </section>
    )
  }

  if (!web.nginxInstalled) {
    return (
      <section className="valet-state is-stopped" aria-live="polite">
        <span className="valet-state-icon"><Glyph name="alert" size={18} /></span>
        <div className="valet-state-copy">
          <strong>Valet is not installed</strong>
          <p>nginx is missing, so there is nothing to serve your sites with yet.</p>
        </div>
      </section>
    )
  }

  if (!web.nginxActive) {
    return (
      <section className="valet-state is-stopped" aria-live="polite">
        <span className="valet-state-icon"><Glyph name="stop" size={18} /></span>
        <div className="valet-state-copy">
          <strong>Valet is stopped</strong>
          <p>nginx is installed but not running, so sites do not open.</p>
          {a.error && <Notice tone="warn">{a.error}</Notice>}
        </div>
        <div className="valet-state-actions">
          <button
            className="btn primary"
            disabled={a.busy}
            onClick={() => void a.act(() => window.api.services.action('nginx', 'start'))}
          >
            <Glyph name={a.busy ? 'spinner' : 'play'} size={13} className={a.busy ? 'spin' : ''} />
            Start nginx
          </button>
          <button className="btn ghost" onClick={() => onNavigate('services')}>Check services</button>
        </div>
      </section>
    )
  }

  if (!web.fpmActive) {
    const fpm = /^\d+\.\d+$/.test(phpVersion) ? `php${phpVersion}-fpm` : 'php-fpm'
    return (
      <section className="valet-state is-partial" aria-live="polite">
        <span className="valet-state-icon"><Glyph name="alert" size={18} /></span>
        <div className="valet-state-copy">
          <strong>Valet is partially running</strong>
          <p>nginx is up, but PHP-FPM is stopped: PHP sites return 502.</p>
          {a.error && <Notice tone="warn">{a.error}</Notice>}
        </div>
        <div className="valet-state-actions">
          <button
            className="btn primary"
            disabled={a.busy}
            onClick={() => void a.act(() => window.api.services.action(fpm, 'start'))}
          >
            <Glyph name={a.busy ? 'spinner' : 'play'} size={13} className={a.busy ? 'spin' : ''} />
            Start PHP-FPM
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="valet-state is-running" aria-live="polite">
      <span className="valet-state-icon"><Glyph name="check" size={18} /></span>
      <div className="valet-state-copy">
        <strong>Valet is running</strong>
        <p>nginx and PHP-FPM are serving your sites.</p>
      </div>
    </section>
  )
}

export function Dashboard({ r, onNavigate, onCreate }: {
  r: Resource<DashboardInfo>
  onNavigate: (tab: Tab) => void
  onCreate: () => void
}) {
  const d = r.data
  const activeServices = d ? d.services.filter((s) => s.active).length : 0
  const totalDatabases = d ? d.databases.reduce((sum, s) => sum + s.databases, 0) : 0
  const installedEngines = d ? d.databases.filter((s) => s.installed) : []
  const activeEngines = installedEngines.filter((s) => s.active)

  return (
    <Page
      title="Dashboard"
      hint="The state of Valet, PHP, Node.js, your databases, mail and DNS on this machine."
      error={r.error}
      loading={r.loading}
      onRefresh={r.reload}
      actions={
        <>
          <button className="btn primary" onClick={onCreate}>
            <Glyph name="plus" size={14} />New project
          </button>
          <button className="btn" onClick={() => onNavigate('settings')}>
            <Glyph name="settings" size={14} />Settings
          </button>
        </>
      }
    >
      {r.loading && !d && <RowsSkeleton rows={6} />}

      {d && (
        <>
          <ValetStatus
            web={d.web}
            phpVersion={d.php.version}
            onChanged={r.reload}
            onNavigate={onNavigate}
          />

          {d.warnings.length > 0 && (
            <div className="notice-stack">
              {d.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
            </div>
          )}

          <div className="metric-grid">
            <Metric
              label="Sites"
              value={d.sites}
              detail={`${d.linked} linked · ${d.parkedFolders} parked ${d.parkedFolders === 1 ? 'folder' : 'folders'}`}
              icon={<Glyph name="sites" size={18} />}
              onClick={() => onNavigate('sites')}
            />
            <Metric
              label="Services"
              value={`${activeServices}/${d.services.length}`}
              detail={activeServices === d.services.length ? 'all running' : 'some stopped'}
              icon={<Glyph name="services" size={18} />}
              onClick={() => onNavigate('services')}
            />
            <Metric
              label="PHP"
              value={d.php.version || '—'}
              detail={d.php.fpmActive ? `FPM running · ${d.php.versions} installed` : 'FPM stopped'}
              icon={<Glyph name="php" size={18} />}
              onClick={() => onNavigate('php')}
            />
            <Metric
              label="Node.js"
              value={d.node.version || '—'}
              detail={`${d.node.versions} installed with nvm`}
              icon={<Glyph name="terminal" size={18} />}
              onClick={() => onNavigate('node')}
            />
            <Metric
              label="Databases"
              value={totalDatabases}
              detail={installedEngines.length === 0
                ? 'No engine installed'
                : `${activeEngines.length} of ${installedEngines.length} ${installedEngines.length === 1 ? 'engine' : 'engines'} running`}
              icon={<Glyph name="database" size={18} />}
              onClick={() => onNavigate('database')}
            />
            <Metric
              label="Mail"
              value={d.mail.running ? d.mail.messages : 'off'}
              detail={d.mail.running ? `Built-in catcher on port ${d.mail.port}` : 'Mail catcher is not listening'}
              icon={<Glyph name="mail" size={18} />}
              onClick={() => onNavigate('mail')}
            />
          </div>

          <div className="dash-columns">
            <Panel
              icon={<Glyph name="services" size={16} />}
              title="Services"
              tag={<span className={`tag ${activeServices === d.services.length ? 'on' : 'warn'}`}>{activeServices}/{d.services.length} running</span>}
            >
              {d.services.length === 0
                ? <EmptyState icon="services" title="No services found">systemd did not report nginx, PHP-FPM or any database unit.</EmptyState>
                : (
                  <ul className="mini-list">
                    {d.services.map((s) => (
                      <li key={s.name}>
                        <span className={`status-dot ${s.active ? 'ok' : 'idle'}`} />
                        <span className="mini-name">{s.name}</span>
                        <span className={`tag ${s.active ? 'on' : ''}`}>{s.active ? 'running' : 'stopped'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              <div className="panel-actions">
                <button className="btn" onClick={() => onNavigate('services')}>Manage services</button>
              </div>
            </Panel>

            <Panel
              icon={<Glyph name="database" size={16} />}
              title="Databases"
              tag={<span className="tag">{totalDatabases} {totalDatabases === 1 ? 'database' : 'databases'}</span>}
            >
              {installedEngines.length === 0
                ? <EmptyState icon="services" title="No database engine installed">Install MariaDB, MySQL or PostgreSQL from your package manager.</EmptyState>
                : (
                  <ul className="mini-list">
                    {installedEngines.map((s) => (
                      <li key={s.engine}>
                        <span className={`status-dot ${s.active ? 'ok' : 'idle'}`} />
                        <span className="mini-name">{s.label}</span>
                        <span className="mini-sub">{s.databases} {s.databases === 1 ? 'database' : 'databases'}</span>
                        <span className={`tag ${s.active ? 'on' : ''}`}>{s.active ? 'running' : 'stopped'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              {d.databases.some((s) => !s.installed) && (
                <p className="panel-note">
                  Not installed: {d.databases.filter((s) => !s.installed).map((s) => s.label).join(', ')}.
                </p>
              )}
              <div className="panel-actions">
                <button className="btn" onClick={() => onNavigate('database')}>Open databases</button>
              </div>
            </Panel>
          </div>

          <div className="dash-columns">
            <Panel icon={<Glyph name="php" size={16} />} title="Runtime versions">
              <dl className="kv">
                <div>
                  <dt>PHP served by Valet</dt>
                  <dd>{d.php.version || 'unknown'} <span className={`tag ${d.php.fpmActive ? 'on' : 'warn'}`}>{d.php.fpmActive ? 'FPM running' : 'FPM stopped'}</span></dd>
                </div>
                <div>
                  <dt>PHP installed</dt>
                  <dd>{d.php.versions} {d.php.versions === 1 ? 'version' : 'versions'}</dd>
                </div>
                <div>
                  <dt>Node.js default</dt>
                  <dd>{d.node.version || 'none'} <span className="muted">· {d.node.versions} installed</span></dd>
                </div>
              </dl>
              <div className="panel-actions">
                <button className="btn" onClick={() => onNavigate('php')}>PHP versions</button>
                <button className="btn" onClick={() => onNavigate('node')}>Node versions</button>
              </div>
            </Panel>

            <Panel
              icon={<Glyph name="mail" size={16} />}
              title="Mail and DNS"
              tag={<span className={`tag ${d.mail.running ? 'on' : 'warn'}`}>{d.mail.running ? 'Catcher running' : 'Catcher offline'}</span>}
            >
              <dl className="kv">
                <div>
                  <dt>Captured messages</dt>
                  <dd>{d.mail.messages} <span className="muted">· SMTP port {d.mail.port || '—'}</span></dd>
                </div>
                <div>
                  <dt>DNS mode</dt>
                  <dd>{d.dns.mode} <span className={`tag ${d.dns.ok ? 'on' : 'warn'}`}>{d.dns.ok ? 'ready' : 'check'}</span></dd>
                </div>
                <div>
                  <dt>Resolution</dt>
                  <dd className="muted">{d.dns.detail}</dd>
                </div>
              </dl>
              <div className="panel-actions">
                <button className="btn" onClick={() => onNavigate('mail')}>Open mail</button>
                <button className="btn" onClick={() => onNavigate('settings')}>Network settings</button>
              </div>
            </Panel>
          </div>

          {d.sites === 0 && (
            <EmptyState icon="sites" title="No sites yet">
              Create a Laravel project with <strong>New project</strong>, or park a folder from
              Settings so every subfolder is served as <code>name.test</code>.
            </EmptyState>
          )}
        </>
      )}
    </Page>
  )
}
