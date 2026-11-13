import { useEffect, useState } from 'react'
import type { AppUpdateState } from '../shared/types'
import { Icon } from './icons'
import { Glyph } from './ui-icons'
import { errorMessage } from './errors'

const LABEL: Record<AppUpdateState['status'], string> = {
  disabled: 'manual install',
  idle: 'not checked',
  checking: 'checking',
  current: 'up to date',
  available: 'update available',
  downloading: 'downloading',
  ready: 'ready to install',
  error: 'check failed'
}

/**
 * Actualización del propio panel. La descarga y la instalación son acciones
 * explícitas: nada se baja ni se reinicia sin que el usuario lo pida.
 */
export function AppUpdatePanel() {
  const [state, setState] = useState<AppUpdateState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void window.api.appUpdate.state().then((s) => { if (alive) setState(s) }).catch(() => '')
    const off = window.api.appUpdate.onEvent((s) => setState(s))
    return () => { alive = false; off() }
  }, [])

  const run = async (action: 'check' | 'download' | 'install') => {
    setBusy(true)
    setError('')
    try {
      const next = await window.api.appUpdate[action]().catch((e: unknown) => {
        setError(errorMessage(e))
        return undefined
      })
      if (next) setState(next)
    } finally {
      setBusy(false)
    }
  }

  const status = state?.status ?? 'idle'
  const busyStatus = busy || status === 'checking' || status === 'downloading'
  const tone = status === 'available' || status === 'ready'
    ? 'warn'
    : status === 'error' || status === 'disabled'
      ? 'warn'
      : 'on'

  return (
    <div className="panel" id="install-app-update">
      <div className="panel-head">
        <span className="panel-icon"><Icon name="folder_update_open" size={18} /></span>
        <h2 className="panel-title">Valet Deck</h2>
        <span className={`tag ${tone}`}>{LABEL[status]}</span>
      </div>

      <p className="panel-note">
        Updates the panel itself from its GitHub releases. The <code>.deb</code> and <code>.rpm</code>
        ask for the administrator password once; the AppImage replaces its own file.
      </p>

      <ul className="rows updates-rows">
        <li>
          <div className="row-main">
            <span className="row-icon"><Icon name="folder_update_open" size={18} /></span>
            <div className="row-text">
              <strong>Valet Deck {state?.current ?? ''}</strong>
              <small>
                {state?.latest && state.latest !== state.current
                  ? `Available: ${state.latest}`
                  : 'Installed version'}
              </small>
              {state?.message && <small className="updates-blocked">{state.message}</small>}
            </div>
          </div>
          <div className="row-meta">
            {status === 'available' ? (
              <button className="btn primary" disabled={busyStatus} onClick={() => void run('download')}>
                <Glyph name="refresh" size={12} />Download {state?.latest}
              </button>
            ) : status === 'ready' ? (
              <button className="btn primary" disabled={busy} onClick={() => void run('install')}>
                <Glyph name="restart" size={12} />Restart and install
              </button>
            ) : status === 'downloading' ? (
              <span className="tag warn">{state?.percent ?? 0}%</span>
            ) : (
              <button className="btn" disabled={busyStatus || status === 'disabled'} onClick={() => void run('check')}>
                <Glyph name="refresh" size={12} />{status === 'checking' ? 'Checking…' : 'Check now'}
              </button>
            )}
          </div>
        </li>
      </ul>

      {status === 'downloading' && (
        <div className="update-progress" role="progressbar" aria-valuenow={state?.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${state?.percent ?? 0}%` }} />
        </div>
      )}

      {status === 'disabled' && (
        <p className="panel-note">
          This development build cannot update itself. Install a released version to receive updates.
        </p>
      )}

      {error && <p className="panel-warn">{error}</p>}
    </div>
  )
}
