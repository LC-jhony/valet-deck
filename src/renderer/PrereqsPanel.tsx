import type { Env } from '../shared/types'
import { CommandBlock } from './CommandBlock'
import { Icon } from './icons'
import { Glyph } from './ui-icons'

/**
 * Requisitos que el panel no puede resolver solo. Cada uno trae el comando que
 * lo arregla, para que un sistema recién instalado no quede en un callejón.
 */
export function PrereqsPanel({ env, onRecheck }: { env: Env; onRecheck: () => void }) {
  const blocking = env.prereqs.filter((p) => !p.ok && p.blocking)
  const pending = env.prereqs.filter((p) => !p.ok && !p.blocking)
  const missing = [...blocking, ...pending]
  if (!missing.length) {
    return (
      <div className="panel" id="settings-prereqs">
        <div className="panel-head">
          <span className="panel-icon"><Icon name="folder_config_open" size={18} /></span>
          <h2 className="panel-title">Prerequisites</h2>
          <span className="tag on"><Glyph name="check" size={11} />all set</span>
          <button type="button" className="btn ghost" onClick={onRecheck}>Check again</button>
        </div>
      </div>
    )
  }

  return (
    <div className="panel" id="settings-prereqs">
      <div className="panel-head">
        <span className="panel-icon"><Icon name="folder_config_open" size={18} /></span>
        <h2 className="panel-title">Prerequisites</h2>
        <span className={`tag ${blocking.length ? 'warn' : ''}`}>
          {blocking.length ? `${blocking.length} block the installation` : `${pending.length} warnings`}
        </span>
        <button type="button" className="btn ghost" onClick={onRecheck}>Check again</button>
      </div>
      <p className="panel-note">
        Copy the commands into a terminal. When you are done, press <strong>Check again</strong>.
      </p>
      <ul className="prereq-list">
        {missing.map((p) => (
          <li key={p.id} className={p.blocking ? 'blocking' : 'warning'}>
            <div className="prereq-head">
              <Glyph name="alert" size={14} />
              <strong>{p.label}</strong>
              <span className="prereq-detail">{p.detail}</span>
            </div>
            {p.commands.length > 0 && <CommandBlock commands={p.commands} />}
          </li>
        ))}
      </ul>
    </div>
  )
}
