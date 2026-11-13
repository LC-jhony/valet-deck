import { useEffect, useMemo, useRef, useState } from 'react'
import type { Env, InstallSummaryRow } from '../shared/types'
import type { MailInfo } from '../shared/mail'
import { setupComponents, setupNeeded, type SetupComponentId } from '../shared/setup'
import { NODE_VERSION } from '../shared/stack'
import type { Tab } from './nav'
import { BrandLogo } from './BrandLogo'
import { Icon, type IconName } from './icons'
import { Glyph } from './ui-icons'
import { CommandBlock } from './CommandBlock'
import { errorMessage } from './errors'

const PKG = 'cpriego/valet-linux'
/**
 * Qué componente puede darse por instalado cuando termina cada paso del
 * instalador. Se marca solo con `ok`: `skip` también significa «no tocaba»
 * (por ejemplo Node cuando no se pidió), y eso no es un check.
 */
const STEP_COMPONENTS: Record<string, SetupComponentId[]> = {
  deps: ['php', 'nginx'],
  composer: ['composer'],
  install: ['valet'],
  node: ['node'],
  mariadb: ['mariadb']
}
const COMPONENT_ICON: Record<SetupComponentId, IconName> = {
  php: 'php',
  composer: 'folder_packages_open',
  nginx: 'nginx',
  valet: 'laravel',
  node: 'folder_console_open',
  mariadb: 'database'
}
/**
 * Pasos que pertenecen a cada aplicación: la barra de la fila avanza con sus
 * pasos reales, mientras la barra global cuenta todos los pasos del plan.
 */
const COMPONENT_STEPS: Record<SetupComponentId, string[]> = {
  php: ['deps', 'php', 'verify'],
  composer: ['deps', 'composer', 'patch'],
  nginx: ['deps', 'install', 'verify'],
  valet: ['composer', 'patch', 'install', 'php', 'park', 'dns', 'verify'],
  node: ['nvm', 'node'],
  mariadb: ['deps', 'mariadb']
}

interface Failure {
  title: string
  detail: string
  hint: string
  commands: string[]
}

const isNode = (env: Env): boolean =>
  env.node.installed && env.node.version.startsWith(`${NODE_VERSION}.`)

const canNode = (env: Env): boolean => Boolean(env.node.nvm || env.tools.git || env.pm)

const networkDown = (env: Env): boolean => {
  const network = env.prereqs.find((p) => p.id === 'network')
  return Boolean(network && !network.ok)
}

/**
 * Ventana de primer arranque. Sustituye a la app hasta que los componentes
 * requeridos están instalados o la persona decide hacerlo más tarde.
 *
 * La instalación usa `skipDns: true`: nunca aplica ni modifica el DNS.
 */
export function SetupScreen({ env, onOpen, onSkip }: {
  env: Env
  onOpen: (tab?: Tab) => void
  onSkip: () => void
}) {
  const [current, setCurrent] = useState(env)
  const [withNode, setWithNode] = useState(() => !isNode(env) && canNode(env) && !networkDown(env))
  const [withMariaDb, setWithMariaDb] = useState(() => Boolean(env.pm && !env.mariadb.active))
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState<{ id: string; label: string; status: string }[]>([])
  const [completed, setCompleted] = useState<Set<SetupComponentId>>(() => new Set())
  const [mail, setMail] = useState<MailInfo>()
  const [log, setLog] = useState('')
  const [error, setError] = useState('')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [summary, setSummary] = useState<InstallSummaryRow[]>([])
  const [ready, setReady] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)

  const components = useMemo(() => setupComponents(current), [current])
  const blockers = current.prereqs.filter((p) => !p.ok && p.blocking)
  const nodeInstalled = isNode(current)
  const nodePossible = canNode(current) && !networkDown(current)
  const mariadbInstalled = current.mariadb.active
  const ports = current.portHogs
  const apacheHogs = ports.length > 0 && ports.every((hog) => /apache/i.test(hog))
  const portBlocked = ports.length > 0 && !apacheHogs
  const nodeBlocked = withNode && networkDown(current)
  const installNeeded = setupNeeded(current) || (withNode && !nodeInstalled) || (withMariaDb && !mariadbInstalled)
  const canInstall = !busy && blockers.length === 0 && !portBlocked && !nodeBlocked
  const canOpen = !busy
  const mailReady = mail?.running === true
  const doneSteps = steps.filter((step) => step.status === 'ok' || step.status === 'skip').length
  const failedStep = steps.some((step) => step.status === 'fail')
  const activeStep = steps.find((step) => step.status === 'run')
  const overall = steps.length ? Math.round((doneSteps / steps.length) * 100) : 0
  const componentProgress = (id: SetupComponentId) => {
    const related = steps.filter((step) => COMPONENT_STEPS[id].includes(step.id))
    const done = related.filter((step) => step.status === 'ok' || step.status === 'skip').length
    const running = related.some((step) => step.status === 'run')
    const failed = related.some((step) => step.status === 'fail')
    return {
      show: related.length > 0 && (running || failed || done > 0),
      running,
      failed,
      percent: related.length ? Math.round((done / related.length) * 100) : 0
    }
  }

  useEffect(() => window.api.install.onEvent((ev) => {
    if (ev.type === 'plan') setSteps(ev.steps.map((step) => ({ ...step, status: 'wait' })))
    else if (ev.type === 'step') {
      setSteps((list) => list.map((step) => step.id === ev.id ? { ...step, status: ev.status } : step))
      // Cada componente recibe su check en cuanto termina su paso, sin
      // esperar a que acabe toda la instalación.
      const ids = ev.status === 'ok' ? STEP_COMPONENTS[ev.id] : undefined
      if (ids) setCompleted((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.add(id)
        return next
      })
    }
    else if (ev.type === 'summary') setSummary(ev.rows)
    else if (ev.type === 'error') setFailure({ title: ev.title, detail: ev.detail, hint: ev.hint, commands: ev.commands })
    else setLog((text) => (text + ev.text).slice(-60_000))
  }), [])

  // El catcher de correo arranca con la app: aquí solo se refleja su estado y
  // se refresca si llega un mensaje durante el setup.
  useEffect(() => {
    let alive = true
    const load = () => window.api.mail.info()
      .then((info) => { if (alive) setMail(info) })
      .catch(() => '')
    void load()
    const off = window.api.mail.onEvent(() => { void load() })
    return () => { alive = false; off() }
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [log])

  // El aviso vive dentro del área con scroll: si aparece, se trae a la vista
  // para que un fallo no quede escondido bajo el pie fijo.
  useEffect(() => {
    if (!error && !failure) return
    alertRef.current?.scrollIntoView({ block: 'nearest' })
  }, [error, failure])

  const start = async () => {
    setBusy(true)
    setError('')
    setFailure(null)
    setSteps([])
    setCompleted(new Set())
    setLog('')
    setSummary([])
    setReady(false)
    try {
      await window.api.install.start({
        pkg: PKG,
        parkDir: '',
        stopApache: true,
        dnsMode: 'safe',
        mariadb: withMariaDb,
        node: withNode,
        skipDns: true
      })
      const next = await window.api.install.check()
      setCurrent(next)
      void window.api.mail.info().then(setMail).catch(() => '')
      if (setupNeeded(next)) {
        setError('Setup finished, but some required components are still missing. Review the log and try again.')
      } else {
        setReady(true)
      }
    } catch (e) {
      const message = errorMessage(e)
      if (message !== 'Operation cancelled') setError(message)
    } finally {
      setBusy(false)
    }
  }

  const primary = () => {
    if (!installNeeded) { onOpen(); return }
    if (!canInstall) return
    void start()
  }

  const optional = (id: SetupComponentId) => {
    if (id === 'node') {
      if (nodeInstalled) return <span className="tag on">installed</span>
      if (!nodePossible) return <span className="tag warn">unavailable</span>
      return (
        <label className="setup-check">
          <input
            type="checkbox"
            checked={withNode}
            disabled={busy}
            onChange={(e) => setWithNode(e.target.checked)}
          />
          Install
        </label>
      )
    }
    if (id === 'mariadb') {
      if (mariadbInstalled) return <span className="tag on">installed</span>
      if (!current.pm) return <span className="tag warn">unavailable</span>
      return (
        <label className="setup-check">
          <input
            type="checkbox"
            checked={withMariaDb}
            disabled={busy}
            onChange={(e) => setWithMariaDb(e.target.checked)}
          />
          Install
        </label>
      )
    }
    return null
  }

  const status = (id: SetupComponentId, installed: boolean, required: boolean) => {
    if (installed || completed.has(id)) {
      return <span className="tag on"><Glyph name="check" size={11} />installed</span>
    }
    const progress = componentProgress(id)
    if (progress.failed) {
      return <span className="tag warn"><Glyph name="alert" size={11} />failed</span>
    }
    if (progress.running) {
      return <span className="tag info"><Glyph name="spinner" size={11} className="spin" />installing</span>
    }
    if (required) return <span className="tag warn">missing</span>
    return optional(id)
  }

  const mailRow = (
    <li key="mail" className={`setup-component ${mailReady ? 'is-installed' : 'is-missing'}`}>
      <span className="setup-component-icon"><Glyph name="mail" size={18} /></span>
      <span className="setup-component-text">
        <strong>Mail catcher</strong>
        <small>
          {mailReady
            ? `Listening on ${mail.host}:${mail.port} · ${mail.messages} message${mail.messages === 1 ? '' : 's'}`
            : mail?.error
              ? `Could not start: ${mail.error}`
              : 'Local inbox · starts with the panel'}
        </small>
      </span>
      {mailReady
        ? (
          <button type="button" className="setup-inbox" disabled={busy} onClick={() => onOpen('mail')}>
            <Glyph name="mail" size={12} />Open inbox
          </button>
        )
        : <span className={`tag ${mail?.error ? 'warn' : ''}`}>{mail?.error ? 'unavailable' : 'starting'}</span>}
    </li>
  )

  if (ready) {
    return (
      <div className="setup-shell">
        <div className="setup-card setup-ready">
          <div className="setup-ready-mark"><Glyph name="check" size={30} /></div>
          <h1>Valet Deck is ready</h1>
          <p className="setup-lead">
            Everything you need is installed. Your DNS configuration was not changed.
          </p>
          <ul className="setup-components">
            {components.map((component) => (
              <li key={component.id} className="setup-component">
                <span className="setup-component-icon"><Icon name={COMPONENT_ICON[component.id]} size={18} /></span>
                <span className="setup-component-text">
                  <strong>{component.label}</strong>
                  <small>{component.detail}</small>
                </span>
                <span className={`tag ${component.installed ? 'on' : component.required ? 'warn' : ''}`}>
                  {component.installed ? <><Glyph name="check" size={11} />installed</> : component.required ? 'missing' : 'not installed'}
                </span>
              </li>
            ))}
            {mailRow}
          </ul>
          {summary.length > 0 && (
            <div className="setup-checks">
              <h2>Checks</h2>
              <ul>
                {summary.map((row) => (
                  <li key={row.id} className={`setup-check-row ${row.state}`}>
                    <Glyph name={row.state === 'ok' ? 'check' : row.state === 'skip' ? 'panel' : 'alert'} size={14} />
                    <span><strong>{row.label}</strong> {row.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="setup-actions">
            <button type="button" className="btn primary" onClick={() => onOpen()}>
              <Glyph name="play" size={13} />Open Valet Deck
            </button>
            <button type="button" className="btn" onClick={() => onOpen('mail')}>
              <Glyph name="mail" size={13} />Open mail inbox
            </button>
          </div>
          <p className="setup-note">
            Open a new terminal so <code>valet</code> is on your PATH, then create a project in{' '}
            <strong>Sites</strong>. Test mail arrives at{' '}
            <code>{mailReady ? `${mail.host}:${mail.port}` : '127.0.0.1:2525'}</code>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="setup-shell">
      <div className="setup-card setup-main">
        <div className="setup-card-body">
          <div className="setup-brand">
            <BrandLogo size={38} />
            <div>
              <span className="setup-kicker">Laravel · PHP · Linux</span>
              <h1>Set up Valet Deck</h1>
            </div>
          </div>

          <p className="setup-lead">
            The local stack your Laravel sites need. The installer only changes what is missing.
          </p>

          {steps.length > 0 && (
            <div className="setup-progress setup-progress-global">
              <div className="setup-progress-head">
                <span className="setup-progress-label">
                  {failedStep
                    ? 'Installation stopped'
                    : activeStep
                      ? activeStep.label
                      : overall === 100
                        ? 'Installation complete'
                        : 'Preparing installation'}
                </span>
                <span>{overall}%</span>
              </div>
              <div
                className={`setup-progress-bar ${failedStep ? 'is-failed' : ''}`}
                role="progressbar"
                aria-label="Installation progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={overall}
              >
                <span className="setup-progress-fill" style={{ width: `${overall}%` }} />
              </div>
              <span className="setup-progress-meta">{doneSteps} of {steps.length} steps</span>
            </div>
          )}

          <ul className="setup-components">
            {components.map((component) => {
              const progress = componentProgress(component.id)
              return (
                <li key={component.id} className={`setup-component ${component.installed || completed.has(component.id) ? 'is-installed' : 'is-missing'}`}>
                  <span className="setup-component-icon"><Icon name={COMPONENT_ICON[component.id]} size={18} /></span>
                  <span className="setup-component-text">
                    <strong>
                      {component.label}
                      {!component.required && <span className="setup-optional">optional</span>}
                    </strong>
                    <small>{component.detail}</small>
                    {progress.show && !(component.installed || completed.has(component.id)) && (
                      <span
                        className={`setup-row-bar ${progress.failed ? 'is-failed' : progress.running ? 'is-running' : ''}`}
                        role="progressbar"
                        aria-label={`${component.label} progress`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progress.running ? undefined : progress.percent}
                      >
                        <span
                          className="setup-row-fill"
                          style={progress.running ? undefined : { width: `${progress.percent}%` }}
                        />
                      </span>
                    )}
                  </span>
                  {status(component.id, component.installed, component.required)}
                </li>
              )
            })}
            {mailRow}
          </ul>

          <ul className="setup-facts">
            <li><Glyph name="lock" size={12} />One password prompt</li>
            <li><Glyph name="check" size={12} />DNS untouched</li>
            <li><Glyph name="panel" size={12} />Backup first</li>
          </ul>

          {blockers.length > 0 && (
            <div className="setup-blockers">
              <p className="panel-warn">Missing requirements before installing:</p>
              <ul>
                {blockers.map((blocker) => (
                  <li key={blocker.id}>
                    <strong>{blocker.label}</strong> {blocker.detail}
                    {blocker.commands.length > 0 && <CommandBlock commands={blocker.commands} />}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {ports.length > 0 && (
            <p className="panel-warn">
              Ports 80/443 are in use: {ports.join(', ')}.{' '}
              {apacheHogs
                ? 'Apache will be stopped and disabled so Valet can use them.'
                : 'Free them before installing.'}
            </p>
          )}
          {withNode && networkDown(current) && (
            <p className="panel-warn">No network: nvm and Node.js cannot be downloaded.</p>
          )}

          {(error || failure) && (
            <div className="setup-alert" ref={alertRef}>
              {error && <div className="error" role="alert"><Glyph name="alert" size={15} /><span>{error}</span></div>}
              {failure && (
                <div className="setup-failure">
                  <strong>{failure.title}</strong>
                  <p>{failure.detail}</p>
                  <p>{failure.hint}</p>
                  {failure.commands.length > 0 && <CommandBlock commands={failure.commands} />}
                </div>
              )}
            </div>
          )}

          {log && (
            <div className="setup-log">
              <div className="section-head"><h2><Glyph name="terminal" size={14} />Log</h2></div>
              <pre className="log" ref={logRef}>{log}</pre>
            </div>
          )}
        </div>

        <div className="setup-actions">
          <button type="button" className="btn primary" disabled={busy || (!installNeeded ? !canOpen : !canInstall)} onClick={primary}>
            {busy
              ? <><Glyph name="spinner" size={13} className="spin" />Installing…</>
              : installNeeded
                ? <><Glyph name="install" size={13} />Install missing components</>
                : <><Glyph name="play" size={13} />Open Valet Deck</>}
          </button>
          {busy
            ? <button type="button" className="btn" onClick={() => void window.api.install.cancel()}><Glyph name="close" size={13} />Cancel</button>
            : <button type="button" className="btn ghost" onClick={onSkip}>Set up later</button>}
        </div>
      </div>
    </div>
  )
}
