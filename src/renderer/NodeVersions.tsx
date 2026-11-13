// Node.js tal como lo ve nvm: versiones instaladas, alias por defecto y los
// sitios que fijan una. Instalar o desinstalar usa nvm, no descargas propias,
// y la salida se muestra en vivo porque la descarga puede tardar.

import { useEffect, useState } from 'react'
import { NVM_SETUP_COMMANDS } from '../shared/stack'
import type { NodeVersionsInfo } from '../shared/site'
import { CommandBlock } from './CommandBlock'
import { EmptyState, Notice, Panel, Page, RowsSkeleton, TaskOutput, useAction, type Resource } from './ui'
import { Glyph } from './ui-icons'

const COMMON = ['20', '22', '24', '26']

export function NodeVersions({ r, onChanged }: { r: Resource<NodeVersionsInfo>; onChanged: () => void }) {
  const a = useAction(r.reload)
  const [major, setMajor] = useState('22')
  const [installing, setInstalling] = useState('')
  const [log, setLog] = useState('')
  const [done, setDone] = useState('')
  const [installError, setInstallError] = useState('')
  const [confirming, setConfirming] = useState('')
  const [removing, setRemoving] = useState('')

  useEffect(() => window.api.node.onInstallEvent((e) => {
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
    }
  }), [r.reload, onChanged])

  const info = r.data
  const install = async () => {
    const value = major.trim().replace(/^v/, '')
    if (!/^\d{1,3}$/.test(value)) {
      setInstallError('Write a major version, for example 22.')
      return
    }
    setInstalling(value)
    setLog('')
    setDone('')
    setInstallError('')
    try {
      await window.api.node.install(value)
    } catch {
      // El evento `done` ya trae el motivo.
    }
  }

  const uninstall = async (version: string) => {
    if (confirming !== version) {
      setConfirming(version)
      return
    }
    setConfirming('')
    setRemoving(version)
    try {
      await a.act(() => window.api.node.uninstall(version))
      onChanged()
    } finally {
      setRemoving('')
    }
  }

  return (
    <Page
      title="Node.js versions"
      hint="Versions installed with nvm, the default alias and the sites that pin one in .nvmrc."
      error={r.error || a.error}
      loading={r.loading}
      onRefresh={r.reload}
    >
      {r.loading && !info && <RowsSkeleton rows={3} />}
      {info && (
        <>
          <div className="metric-grid metric-grid-3">
            <div className="metric">
              <span className="metric-top"><span className="metric-label">nvm default</span><span className="metric-icon"><Glyph name="terminal" size={18} /></span></span>
              <strong className="metric-value">{info.defaultVersion || '—'}</strong>
              <span className="metric-detail">Used by new shells and <code>nvm use</code> without arguments.</span>
            </div>
            <div className="metric">
              <span className="metric-top"><span className="metric-label">Installed</span><span className="metric-icon"><Glyph name="services" size={18} /></span></span>
              <strong className="metric-value">{info.versions.length}</strong>
              <span className="metric-detail">Versions under <code>{info.nvmDir}/versions/node</code>.</span>
            </div>
            <div className="metric">
              <span className="metric-top"><span className="metric-label">nvm</span><span className="metric-icon"><Glyph name="check" size={18} /></span></span>
              <strong className="metric-value">{info.nvm ? 'available' : 'missing'}</strong>
              <span className="metric-detail">{info.nvm ? 'Loaded from your home folder.' : 'Install it below or run the commands shown here.'}</span>
            </div>
          </div>

          {info.warning && <Notice tone="warn">{info.warning}</Notice>}

          <Panel
            icon={<Glyph name="install" size={16} />}
            title="Install a version"
            tag={<span className="tag">nvm install</span>}
          >
            <div className="inline-form">
              <label className="field-block">
                <span className="field-block-label">Major version</span>
                <input
                  value={major}
                  list="node-majors"
                  placeholder="22"
                  inputMode="numeric"
                  onChange={(e) => setMajor(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !installing) void install() }}
                />
              </label>
              <datalist id="node-majors">
                {COMMON.map((v) => <option key={v} value={v} />)}
              </datalist>
              <button className="btn primary" disabled={Boolean(installing) || !info.nvm} onClick={() => void install()}>
                <Glyph name={installing ? 'spinner' : 'plus'} size={13} className={installing ? 'spin' : ''} />
                {installing ? 'Installing…' : 'Install'}
              </button>
            </div>
            <div className="presets">
              {COMMON.map((v) => (
                <button key={v} type="button" className="btn" onClick={() => setMajor(v)} disabled={Boolean(installing)}>
                  Node {v}
                </button>
              ))}
            </div>
            <p className="panel-note">
              Installing with nvm does not change the default alias. Use <strong>Set default</strong> on
              the version you want new terminals to load.
            </p>
            {!info.nvm && (
              <>
                <p className="panel-note">nvm is not installed. The panel installs it with the button below, or you can run:</p>
                <CommandBlock commands={NVM_SETUP_COMMANDS} />
              </>
            )}
          </Panel>

          <Panel icon={<Glyph name="terminal" size={16} />} title="Installed versions">
            {info.versions.length === 0
              ? <EmptyState icon="terminal" title="No Node versions yet">Install one above; nvm keeps each version in its own folder.</EmptyState>
              : (
                <ul className="rows rows-flat">
                  {info.versions.map((v) => (
                    <li key={v.version}>
                      <div className="row-main">
                        <span className="row-icon"><Glyph name="terminal" size={18} /></span>
                        <div className="row-text">
                          <strong>Node.js {v.version}</strong>
                          <small>{v.path}</small>
                        </div>
                      </div>
                      <div className="row-meta">
                        {v.isDefault && <span className="tag on">default</span>}
                        <span className="tag">major {v.major}</span>
                        <span className="tag">npm {v.npm ?? '—'}</span>
                        {v.sites.length > 0 && <span className="tag info">{v.sites.length} {v.sites.length === 1 ? 'site' : 'sites'}</span>}
                      </div>
                      <div className="row-actions">
                        <button
                          className="btn"
                          disabled={a.busy || v.isDefault}
                          onClick={() => a.act(async () => { await window.api.node.setDefault(String(v.major)); onChanged() })}
                        >
                          <Glyph name="check" size={13} />
                          {v.isDefault ? 'Default' : 'Set default'}
                        </button>
                        <button
                          className={`btn ${confirming === v.version ? 'danger' : ''}`}
                          disabled={a.busy || v.isDefault || Boolean(removing)}
                          title={v.isDefault ? 'Change the default before removing this version' : undefined}
                          onClick={() => void uninstall(v.version)}
                          onBlur={() => { if (confirming === v.version) setConfirming('') }}
                        >
                          <Glyph name={removing === v.version ? 'spinner' : 'close'} size={13} className={removing === v.version ? 'spin' : ''} />
                          {confirming === v.version ? 'Confirm remove' : 'Remove'}
                        </button>
                      </div>
                      {v.sites.length > 0 && (
                        <div className="row-wide">
                          <span className="muted">Used by:</span>
                          {v.sites.map((s) => <span key={s} className="tag">{s}</span>)}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
          </Panel>

          <TaskOutput text={log} busy={Boolean(installing)} done={done} error={installError} />

          <p className="panel-note">
            To pin a version for one project, open <strong>Sites → the site → PHP &amp; Node.js</strong>.
            The panel writes <code>.nvmrc</code> so every tool in that folder agrees.
          </p>
        </>
      )}
    </Page>
  )
}
