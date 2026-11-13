// Diálogo de borrado de un sitio. Quitar un enlace no toca los archivos; borrar
// la carpeta es irreversible y exige escribir el nombre. Un sitio parkeado no
// se puede quitar de Valet sin borrar su carpeta, así que ese caso lo explica.

import { useState } from 'react'
import type { Site } from '../shared/types'
import { Modal } from './Modal'
import { Glyph } from './ui-icons'
import { errorMessage } from './errors'

export function DeleteSiteDialog({ site, onClose, onDeleted }: {
  site: Site
  onClose: () => void
  onDeleted: () => void
}) {
  const [deleteFiles, setDeleteFiles] = useState(site.kind === 'parked')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const destructive = deleteFiles || site.kind === 'parked'
  const ready = !busy && (!destructive || typed.trim() === site.name)

  const remove = async () => {
    if (!ready) return
    setBusy(true)
    setError('')
    try {
      await window.api.sites.remove(site.name, { deleteFiles })
      onDeleted()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal labelledBy="delete-site-title" onClose={onClose} busy={busy}>
      <header className="page-head">
        <h1 id="delete-site-title">Delete {site.name}</h1>
        <button className="btn ghost" onClick={onClose} disabled={busy} aria-label="Cancel deletion">
          <Glyph name="close" size={13} />Cancel
        </button>
      </header>

      <dl className="kv">
        <div><dt>Folder</dt><dd><code>{site.path}</code></dd></div>
        <div><dt>Type</dt><dd>{site.kind === 'linked' ? 'linked site' : 'inside a parked folder'}</dd></div>
      </dl>

      {site.kind === 'linked' ? (
        <label className="check">
          <input
            type="checkbox"
            checked={deleteFiles}
            disabled={busy}
            onChange={(e) => { setDeleteFiles(e.target.checked); setTyped('') }}
          />
          Also delete the project folder and its files
        </label>
      ) : (
        <p className="panel-note">
          This site lives inside a parked folder. Removing it from Valet means deleting its
          folder; the parked folder itself stays.
        </p>
      )}

      <p className="panel-note">
        {deleteFiles
          ? 'The folder and everything inside it will be removed. This cannot be undone. Databases and backups are not deleted.'
          : 'The folder stays on disk. Only the Valet link is removed; you can link it again later.'}
      </p>

      {destructive && (
        <label className="field">
          <span>Type <code>{site.name}</code> to confirm</span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            placeholder={site.name}
          />
        </label>
      )}

      {error && <p className="panel-warn" role="alert">{error}</p>}

      <footer>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn danger" onClick={() => void remove()} disabled={!ready}>
          <Glyph name={busy ? 'spinner' : 'close'} size={13} className={busy ? 'spin' : ''} />
          {busy
            ? 'Working…'
            : deleteFiles
              ? 'Delete site and files'
              : 'Remove from Valet'}
        </button>
      </footer>
    </Modal>
  )
}
