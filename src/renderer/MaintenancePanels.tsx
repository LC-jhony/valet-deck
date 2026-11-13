// Mantenimiento del sistema dentro de Settings: actualizaciones, requisitos,
// DNS y seguridad de MariaDB. La instalación en sí vive en la ventana de
// primer arranque; aquí solo se repara o actualiza lo ya instalado.

import { useEffect, useRef, useState } from 'react'
import type { DnsMode, Env } from '../shared/types'
import { NODE_VERSION } from '../shared/stack'
import { AppUpdatePanel } from './AppUpdatePanel'
import { UpdatesPanel } from './UpdatesPanel'
import { PrereqsPanel } from './PrereqsPanel'
import { DnsPanel } from './DnsPanel'
import { Notice, type Resource } from './ui'
import { Glyph } from './ui-icons'
import { errorMessage } from './errors'

/** Paquete de Valet que instala y desinstala el panel en su Composer aislado. */
const VALET_PACKAGE = 'cpriego/valet-linux'

/**
 * Paneles que antes vivían en la pestaña Installation. Reciben el diagnóstico
 * completo (`window.api.install.check`) y recargan el recurso al terminar cada
 * acción para que los estados vuelvan a ser reales.
 */
export function MaintenancePanels({ env }: { env: Resource<Env> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [secureMsg, setSecureMsg] = useState('')
  const [secureErr, setSecureErr] = useState('')
  const [dnsMode, setDnsMode] = useState<DnsMode>('safe')
  const dnsInitialized = useRef(false)
  const data = env.data
  const stackParts = data
    ? [
        data.valet.installed ? 'Laravel Valet' : '',
        data.php.installed ? `PHP ${data.php.current || data.php.managed}`.trim() : '',
        data.tools.composer ? 'Composer' : '',
        data.node.installed ? `Node.js ${data.node.version}`.trim() : '',
        data.mariadb.installed ? 'MariaDB' : ''
      ].filter(Boolean)
    : []

  useEffect(() => {
    if (dnsInitialized.current || !data?.recommendedDnsMode) return
    dnsInitialized.current = true
    setDnsMode(data.recommendedDnsMode)
  }, [data?.recommendedDnsMode])

  // El motivo se muestra junto al modo seguro: «no disponible» sin decir por
  // qué obliga a adivinar entre tres comprobaciones.
  const safeReason = !data
    ? 'system data is missing'
    : !data.dns.resolvedActive
      ? 'systemd-resolved is not running'
      : !data.dns.resolvConfOk
        ? '/etc/resolv.conf does not point to systemd-resolved'
        : !data.dns.portFree
          ? `port ${data.dns.port} is in use`
          : ''

  const run = async (fn: () => Promise<void>, done = '') => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      await fn()
      setNote(done)
    } catch (e) {
      const message = errorMessage(e)
      // Cancelar no es un fallo: no merece el cartel rojo.
      if (message !== 'Operation cancelled') setError(message)
    } finally {
      setBusy(false)
      env.reload()
    }
  }

  const openSecureInstallation = async () => {
    setSecureMsg('')
    setSecureErr('')
    try {
      const term = await window.api.mariadb.secureInstall()
      setSecureMsg(`Opened in ${term}. The terminal window asks for the administrator password.`)
    } catch (e) {
      setSecureErr(errorMessage(e))
    }
  }

  return (
    <>
      <AppUpdatePanel />

      <UpdatesPanel visible busy={busy} onRun={(id) => run(() => window.api.updates.run(id))} />

      {data && <PrereqsPanel env={data} onRecheck={env.reload} />}

      {error && <Notice tone="warn">{error}</Notice>}
      {note && <Notice tone="ok">{note}</Notice>}

      {data && (
        <DnsPanel
          env={data}
          dnsMode={dnsMode}
          onMode={setDnsMode}
          installed={data.valet.installed}
          busy={busy}
          safeReason={safeReason}
          onRepair={() => run(
            () => window.api.install.repairDns(dnsMode === 'hosts' ? 'hosts' : 'safe'),
            'DNS repaired with the selected mode.'
          )}
          onSync={() => run(() => window.api.install.syncHosts(), '/etc/hosts is in sync with your sites.')}
        />
      )}

      {data && (
        <div className="panel" id="settings-uninstall">
          <div className="panel-head">
            <span className="panel-icon"><Glyph name="install" size={17} /></span>
            <h2 className="panel-title">Uninstall</h2>
            <span className={`tag ${data.valet.installed ? (data.valet.isolated ? 'on' : 'warn') : ''}`}>
              {data.valet.installed ? (data.valet.isolated ? 'managed' : 'external') : 'nothing installed'}
            </span>
          </div>
          <p className="panel-note">
            Removes the local stack to leave a clean machine: Laravel Valet, PHP, Composer,
            Node.js {NODE_VERSION} installed with nvm and MariaDB (only if Valet Deck installed
            it). Your sites, backups and nginx stay. This action cannot be undone.
          </p>
          <p className="panel-note">
            {data.valet.installed && !data.valet.isolated
              ? 'The external Valet stays installed, but removing PHP leaves it unusable; remove it with its own tooling first if you want to keep it.'
              : 'A new restart opens the first-run installer with every component missing.'}
          </p>
          <div className="panel-actions">
            {busy && (
              <span className="panel-note">Removing packages… this can take a few minutes. Keep the window open.</span>
            )}
            <button
              className="btn danger"
              disabled={busy || stackParts.length === 0}
              onClick={() => {
                const list = stackParts.length ? stackParts.join(', ') : 'the local stack'
                if (confirm(
                  `Uninstall ${list}?\n\n` +
                  'This purges the PHP, Composer and MariaDB packages and removes Node.js from nvm. ' +
                  'Sites, backups and nginx are kept. This cannot be undone.'
                )) {
                  void run(
                    () => window.api.install.uninstall(VALET_PACKAGE, { full: true }),
                    'Stack removed. Restart Valet Deck to open the first-run installer.'
                  )
                }
              }}
            >
              <Glyph name={busy ? 'spinner' : 'close'} size={13} className={busy ? 'spin' : ''} />
              {stackParts.length ? 'Uninstall everything' : 'Nothing to uninstall'}
            </button>
          </div>
        </div>
      )}

      {data?.mariadb.installed && (
        <div className="panel" id="settings-mariadb-security">
          <div className="panel-head">
            <span className="panel-icon"><Glyph name="terminal" size={17} /></span>
            <h2 className="panel-title">MariaDB security</h2>
          </div>
          <p className="panel-note">
            The panel creates or checks the managed <code>valet_studio</code> user. Its password
            is kept in <code>~/.valet-studio/mariadb.json</code> with mode 0600 and never written
            to the log.
          </p>
          <p className="panel-note">
            The secure installation is manual: the assistant lets you remove anonymous users,
            drop the <code>test</code> database and protect <code>root</code>. The panel never
            runs those changes on its own.
          </p>
          <div className="panel-actions">
            <button className="btn" disabled={!data.mariadb.active} onClick={() => void openSecureInstallation()}>
              <Glyph name="terminal" size={14} />Open secure installation
            </button>
            {secureMsg && <span className="panel-note">{secureMsg}</span>}
            {secureErr && <span className="panel-warn">{secureErr}</span>}
            {!data.mariadb.active && <span className="panel-note">Start the MariaDB service first.</span>}
          </div>
        </div>
      )}
    </>
  )
}
