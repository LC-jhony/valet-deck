// Ajustes generales: el dominio de desarrollo, las carpetas parkeadas, las
// versiones por defecto, las rutas del panel y el acceso al tema. Cada acción
// escribe a través de Valet o del propio panel; aquí no se edita un archivo a
// mano.

import { useEffect, useState } from 'react'
import type { SystemSettings } from '../shared/site'
import type { Env } from '../shared/types'
import type { Tab } from './nav'
import { Notice, Panel, Page, RowsSkeleton, useAction, type Resource } from './ui'
import { Glyph } from './ui-icons'
import { MaintenancePanels } from './MaintenancePanels'

function Locations({ settings }: { settings: SystemSettings }) {
  const [opening, setOpening] = useState('')
  const [error, setError] = useState('')

  const open = async (kind: 'data' | 'valet' | 'sites' | 'nvm') => {
    setOpening(kind)
    setError('')
    try {
      await window.api.system.openFolder(kind)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setOpening('')
    }
  }

  const rows: { kind: 'data' | 'valet' | 'sites' | 'nvm'; label: string; path: string; what: string }[] = [
    { kind: 'data', label: 'Panel data', path: settings.dataDir, what: 'Backups, saved site settings and queue logs.' },
    { kind: 'valet', label: 'Valet home', path: settings.valetHome, what: 'Certificates, nginx snippets and Valet configuration.' },
    { kind: 'sites', label: 'Linked sites', path: settings.sitesDir, what: 'Symlinks created with valet link.' },
    { kind: 'nvm', label: 'nvm', path: settings.nodeDir, what: 'Node versions and the default alias.' }
  ]

  return (
    <>
      {error && <Notice tone="warn">{error}</Notice>}
      <ul className="rows rows-flat">
        {rows.map((row) => (
          <li key={row.kind}>
            <div className="row-main">
              <span className="row-icon"><Glyph name="sites" size={16} /></span>
              <div className="row-text"><strong>{row.label}</strong><small>{row.path}</small></div>
            </div>
            <div className="row-meta"><span className="muted">{row.what}</span></div>
            <div className="row-actions">
              <button className="btn" disabled={Boolean(opening)} onClick={() => void open(row.kind)}>
                <Glyph name={opening === row.kind ? 'spinner' : 'globe'} size={13} className={opening === row.kind ? 'spin' : ''} />
                Open
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

export function SettingsPage({ r, env, onAppearance, onNavigate }: {
  r: Resource<SystemSettings>
  env: Resource<Env>
  onAppearance: () => void
  onNavigate: (tab: Tab) => void
}) {
  const a = useAction(r.reload)
  const [domain, setDomain] = useState('')
  const [adding, setAdding] = useState(false)
  const [pathError, setPathError] = useState('')
  const s = r.data

  useEffect(() => { if (s) setDomain(s.domain) }, [s?.domain]) // eslint-disable-line react-hooks/exhaustive-deps

  const domainReady = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain.trim().toLowerCase())
    && domain.trim().length > 0
    && domain.trim().length <= 63

  const addPath = async () => {
    setAdding(true)
    setPathError('')
    try {
      const picked = await window.api.sites.pickDirectory()
      if (!picked) return
      await a.act(() => window.api.system.addParkedPath(picked))
    } catch (e) {
      setPathError(e instanceof Error ? e.message : String(e))
    } finally {
      setAdding(false)
    }
  }

  return (
    <Page
      title="Settings"
      hint="Domain, parked folders, default versions and where the panel keeps its data."
      error={r.error || a.error}
      loading={r.loading}
      onRefresh={r.reload}
      actions={
        <button className="btn" onClick={onAppearance}>
          <Glyph name="settings" size={14} />Appearance
        </button>
      }
    >
      {r.loading && !s && <RowsSkeleton rows={4} />}
      {s && (
        <>
          <Panel
            id="settings-domain"
            icon={<Glyph name="globe" size={16} />}
            title="Development domain"
            tag={<span className="tag info">{s.domain}</span>}
          >
            <div className="inline-form">
              <label className="field-block">
                <span className="field-block-label">Top-level domain</span>
                <input value={domain} onChange={(e) => setDomain(e.target.value)} spellCheck={false}
                  placeholder="test" />
              </label>
              <button className="btn primary" disabled={a.busy || !domainReady || (domain.trim().toLowerCase() === s.domain && s.domainConfigured)}
                onClick={() => a.act(() => window.api.system.setDomain(domain.trim().toLowerCase()))}>
                <Glyph name="check" size={13} />Save domain
              </button>
            </div>
            {!s.domainConfigured && (
              <Notice tone="warn">
                Valet has no domain in its configuration, so sites are served as <code>name.</code>.
                Save <code>test</code> (or another domain) to repair it; secured sites are regenerated.
              </Notice>
            )}
            <p className="panel-note">
              Sites are served as <code>name.{s.domain}</code>. Changing it updates Valet and rewrites
              its nginx server names. After a change, use <strong>Maintenance → Network and DNS</strong> to
              repair DNS so the new names resolve; existing certificates stay valid for the old names.
            </p>
          </Panel>

          <Panel
            id="settings-parked"
            icon={<Glyph name="sites" size={16} />}
            title="Parked folders"
            tag={<span className="tag">{s.parkedPaths.length}</span>}
          >
            {s.parkedPaths.length === 0
              ? <p className="panel-note">No folder is parked. Every subfolder of a parked folder becomes a site.</p>
              : (
                <ul className="rows rows-flat">
                  {s.parkedPaths.map((path) => (
                    <li key={path}>
                      <div className="row-main">
                        <span className="row-icon"><Glyph name="sites" size={16} /></span>
                        <div className="row-text"><strong>{path.split('/').pop() || path}</strong><small>{path}</small></div>
                      </div>
                      <div className="row-actions">
                        <button className="btn danger" disabled={a.busy}
                          onClick={() => a.act(() => window.api.system.removeParkedPath(path))}>
                          <Glyph name="close" size={13} />Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            <div className="panel-actions">
              <button className="btn" disabled={a.busy || adding} onClick={() => void addPath()}>
                <Glyph name={adding ? 'spinner' : 'plus'} size={13} className={adding ? 'spin' : ''} />
                Add folder…
              </button>
              <button className="btn ghost" onClick={() => onNavigate('sites')}>Open sites</button>
            </div>
            {pathError && <Notice tone="warn">{pathError}</Notice>}
            <p className="panel-note">
              Removing a parked folder stops serving its subfolders; it does not delete any project.
            </p>
          </Panel>

          <div className="dash-columns" id="settings-runtime">
            <Panel icon={<Glyph name="php" size={16} />} title="Default PHP">
              <dl className="kv">
                <div><dt>Version served by Valet</dt><dd>{s.defaultPhp || 'unknown'}</dd></div>
                <div><dt>Ports</dt><dd>HTTP {s.httpPort} · HTTPS {s.httpsPort}</dd></div>
              </dl>
              <div className="panel-actions">
                <button className="btn" onClick={() => onNavigate('php')}>PHP versions</button>
                <button className="btn ghost" onClick={() => onNavigate('ports')}>Ports</button>
              </div>
            </Panel>

            <Panel icon={<Glyph name="terminal" size={16} />} title="Default Node.js">
              <dl className="kv">
                <div><dt>nvm default alias</dt><dd>{s.defaultNode || 'none'}</dd></div>
                <div><dt>nvm folder</dt><dd className="muted"><code>{s.nodeDir}</code></dd></div>
              </dl>
              <div className="panel-actions">
                <button className="btn" onClick={() => onNavigate('node')}>Node versions</button>
              </div>
            </Panel>
          </div>

          <Panel
            id="settings-locations"
            icon={<Glyph name="sites" size={16} />}
            title="Locations"
            tag={<span className="tag">read only</span>}
          >
            <Locations settings={s} />
          </Panel>

          <div className="section-head" id="settings-maintenance">
            <h2>Maintenance</h2>
            <span>updates · DNS · prerequisites · MariaDB</span>
          </div>
          <MaintenancePanels env={env} />

          <Panel icon={<Glyph name="settings" size={16} />} title="Interface">
            <dl className="kv">
              <div><dt>Theme and palette</dt><dd>Dark or light, two palettes, four fonts and text size.</dd></div>
              <div><dt>Maintenance</dt><dd>Panel updates, component updates, DNS repair and MariaDB security.</dd></div>
            </dl>
            <div className="panel-actions">
              <button className="btn" onClick={onAppearance}>
                <Glyph name="settings" size={13} />Open appearance
              </button>
            </div>
          </Panel>
        </>
      )}
    </Page>
  )
}
