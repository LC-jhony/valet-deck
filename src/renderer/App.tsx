import {
  useCallback, useEffect, useRef, useState,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode
} from 'react'
import type { Env, PhpInfo, PortsInfo, PortUsage, Service, Site } from '../shared/types'
import type { DashboardInfo, DatabasesInfo, NodeVersionsInfo, SystemSettings } from '../shared/site'

import { setupNeeded } from '../shared/setup'
import type { MailInfo } from '../shared/mail'
import { useResolvedMode, useSettings, type Settings } from './theme'
import { Icon, IconProvider, type IconName } from './icons'
import { BrandLockup, BrandLogo } from './BrandLogo'
import { Glyph } from './ui-icons'
import { modalsOpen } from './Modal'
import { SettingsDialog } from './SettingsDialog'
import { CreateProjectDialog } from './CreateProjectDialog'
import { DeleteSiteDialog } from './DeleteSiteDialog'
import { MailPage, MailSidebar } from './mail/MailPage'
import { SetupScreen } from './SetupScreen'
import { errorMessage } from './errors'
import { EmptyState, Notice, Page, Panel, RowsSkeleton, useAction, useResource, type Resource } from './ui'
import { SECTIONS, type Tab } from './nav'
import { Dashboard } from './Dashboard'
import { SiteDetail } from './SiteDetail'
import { PhpVersions } from './PhpVersions'
import { NodeVersions } from './NodeVersions'
import { DatabasePage } from './DatabasePage'
import { SettingsPage } from './SettingsPage'

const KNOWN: Record<number, string> = { 53: 'DNS (dnsmasq)', 80: 'HTTP', 443: 'HTTPS', 3306: 'MySQL', 5354: 'Safe DNS (Valet Deck)', 6379: 'Redis' }
const RESERVED_PORTS = new Set([53, 67, 68, 123, 5353, 5354])
const WIDTH_KEY = 'valetdeck:sidebar-width'
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 420
const SIDEBAR_DEFAULT = 268

const validPort = (v: string) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535
const validWebPort = (v: string) => validPort(v) && !RESERVED_PORTS.has(Number(v))

const serviceIcon = (name: string): IconName => {
  if (/nginx/i.test(name)) return 'nginx'
  if (/mysql|maria|postgres/i.test(name)) return 'database'
  if (/redis/i.test(name)) return 'folder_redis_open'
  if (/php/i.test(name)) return 'php'
  if (/apache/i.test(name)) return 'folder_server_open'
  if (/dns/i.test(name)) return 'folder_connection_open'
  return 'folder_config_open'
}

const portIcon = (u: PortUsage): IconName => {
  if (/mysql|maria|postgres/i.test(u.process) || [3306, 5432].includes(u.port)) return 'database'
  if (/redis/i.test(u.process) || u.port === 6379) return 'folder_redis_open'
  if (/php/i.test(u.process)) return 'php'
  if (/apache/i.test(u.process)) return 'folder_server_open'
  if (/nginx|valet/i.test(u.process) || [80, 443, 8080, 8443].includes(u.port)) return 'http'
  return 'folder_connection_open'
}

function portConflicts(info: PortsInfo) {
  const mine = new Set([info.config.http, info.config.https])
  return info.usage.filter((u) => {
    const proc = u.process === '—' && mine.has(u.port) && info.nginxActive ? 'nginx' : u.process
    return mine.has(u.port) && proc !== 'nginx'
  }).length
}

function SideSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="side-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="side-skeleton-row" key={i}>
          <span className="sk-icon" />
          <span className="sk-lines"><span className="sk-line w1" /><span className="sk-line w2" /></span>
        </div>
      ))}
    </div>
  )
}

function SideAlert({ children }: { children: ReactNode }) {
  return <div className="side-alert" role="alert"><Glyph name="alert" size={14} /><span>{children}</span></div>
}

function SideEmpty({ children }: { children: ReactNode }) {
  return <div className="side-empty"><Glyph name="info" size={16} /><span>{children}</span></div>
}

function Sidebar({ title, badge, onRefresh, loading, onHide, open, onResizeStart, children }: {
  title: string
  badge?: string
  onRefresh: () => void
  loading: boolean
  onHide: () => void
  open: boolean
  onResizeStart: (e: ReactPointerEvent<HTMLDivElement>) => void
  children: ReactNode
}) {
  return (
    <aside className="sidebar" aria-label={`Panel for ${title}`} inert={!open}>
      <div className="side-head">
        <div className="side-title">
          <span>{title}</span>
          {badge && <span className="side-badge">{badge}</span>}
        </div>
        <div className="side-tools">
          <button className="icon-btn" onClick={onRefresh} disabled={loading} title="Refresh" aria-label="Refresh">
            <Glyph name="refresh" size={15} className={loading ? 'spin' : ''} />
          </button>
          <button className="icon-btn" onClick={onHide} title="Hide panel (Ctrl+B)" aria-label="Hide panel">
            <Glyph name="panel" size={15} />
          </button>
        </div>
      </div>
      <div className="side-scroll">{children}</div>
      <div className="side-resize" onPointerDown={onResizeStart} role="separator" aria-orientation="vertical" aria-label="Resize panel" />
    </aside>
  )
}

function SitesSidebar({ r, query, setQuery, selected, onSelect }: {
  r: Resource<Site[]>
  query: string
  setQuery: (v: string) => void
  selected: string | null
  onSelect: (name: string) => void
}) {
  const all = r.data ?? []
  const q = query.trim().toLowerCase()
  const list = q ? all.filter((s) => s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q)) : all
  const secure = all.filter((s) => s.secure).length
  return (
    <>
      <div className="side-search">
        <div className="search-box">
          <Glyph name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sites" aria-label="Search sites" spellCheck={false} />
          {query && (
            <button className="side-clear" onClick={() => setQuery('')} aria-label="Clear search">
              <Glyph name="close" size={12} />
            </button>
          )}
        </div>
      </div>
      {r.error && <SideAlert>{r.error}</SideAlert>}
      {r.loading && !r.data && <SideSkeleton rows={6} />}
      {r.data && list.length === 0 && (
        <SideEmpty>{query ? 'No matches for your search.' : 'No sites yet. Use valet park or valet link.'}</SideEmpty>
      )}
      <ul className="side-list">
        {list.map((s) => (
          <li key={s.name}>
            <button className={`side-item ${selected === s.name ? 'selected' : ''}`} onClick={() => onSelect(s.name)} title={s.path}>
              <Icon name={s.kind === 'linked' ? 'folder_link_open' : 'folder_home_open'} size={17} />
              <span className="side-item-text">
                <span className="side-item-name">{s.name}</span>
                <span className="side-item-sub">{s.path}</span>
              </span>
              {s.secure && <Glyph name="lock" size={12} className="side-item-icon" />}
            </button>
          </li>
        ))}
      </ul>
      {all.length > 0 && (
        <div className="side-summary">
          <span>{query ? `${list.length} of ${all.length}` : `${all.length} ${all.length === 1 ? 'site' : 'sites'}`}</span>
          <span>{secure} with HTTPS</span>
        </div>
      )}
      <p className="side-note">Click a site to open its detail: versions, database, mail, queues and logs.</p>
    </>
  )
}

function PhpSidebar({ r }: { r: Resource<PhpInfo> }) {
  const info = r.data
  const label = info?.managed ? `PHP ${info.managed}` : 'PHP'
  const inUse = Boolean(info && info.installed && (!info.target || info.current === info.target))
  return (
    <>
      {r.error && <SideAlert>{r.error}</SideAlert>}
      {r.loading && !r.data && <SideSkeleton rows={2} />}
      {info && (
        <div className="side-current">
          <span className="side-current-icon"><Icon name="php" size={20} /></span>
          <div>
            <span className="side-label">Managed</span>
            <strong>{label}</strong>
            <span className="side-current-sub">
              {info.fpmActive
                ? 'php-fpm running'
                : info.installed
                  ? 'php-fpm stopped'
                  : 'not installed'}
            </span>
          </div>
          <span className={`status-dot ${inUse && info.fpmActive ? 'ok' : 'warn'}`} />
        </div>
      )}
      {info?.target && info.current && info.current !== info.target && (
        <SideAlert>php reports {info.current}. Repair PHP {info.target} from Settings → Maintenance.</SideAlert>
      )}
      <p className="side-note">Valet serves one default version. Any site can be isolated on another installed version from its PHP &amp; Node.js tab.</p>
    </>
  )
}

function DashboardSidebar({ r, onNavigate }: { r: Resource<DashboardInfo>; onNavigate: (tab: Tab) => void }) {
  const d = r.data
  const warnings = d?.warnings ?? []
  const webIssue = d
    ? d.web.conflict
      ? `${d.web.conflict.process.replace(/\s*\([^)]*\)\s*$/, '')} is using Valet's web ports.`
      : !d.web.nginxInstalled
        ? 'Valet is not installed: nginx is missing.'
        : !d.web.nginxActive
          ? 'Valet is stopped: nginx is not running.'
          : !d.web.fpmActive
            ? 'PHP-FPM is stopped: PHP sites return 502.'
            : ''
    : ''
  return (
    <>
      {r.error && <SideAlert>{r.error}</SideAlert>}
      {r.loading && !d && <SideSkeleton rows={4} />}
      {d && (
        <>
          {webIssue && <SideAlert>{webIssue}</SideAlert>}
          {warnings.map((w) => <SideAlert key={w}>{w}</SideAlert>)}
          {!webIssue && warnings.length === 0 && <SideEmpty>Everything Valet needs is running.</SideEmpty>}
          <div className="side-group-label">Shortcuts</div>
          <button className="side-card" onClick={() => onNavigate('sites')}>
            <span className="side-card-icon"><Icon name="folder_home_open" size={18} /></span>
            <span className="side-card-text"><strong>Sites</strong><small>{d.sites} served · {d.linked} linked</small></span>
          </button>
          <button className="side-card" onClick={() => onNavigate('php')}>
            <span className="side-card-icon"><Icon name="php" size={18} /></span>
            <span className="side-card-text"><strong>PHP</strong><small>{d.php.version || 'unknown'} · {d.php.versions} installed</small></span>
          </button>
          <button className="side-card" onClick={() => onNavigate('node')}>
            <span className="side-card-icon"><Icon name="folder_config_open" size={18} /></span>
            <span className="side-card-text"><strong>Node.js</strong><small>{d.node.version || 'none'} · {d.node.versions} installed</small></span>
          </button>
          <button className="side-card" onClick={() => onNavigate('database')}>
            <span className="side-card-icon"><Icon name="database" size={18} /></span>
            <span className="side-card-text"><strong>Databases</strong><small>{d.databases.reduce((n, s) => n + s.databases, 0)} across {d.databases.length} engines</small></span>
          </button>
          <button className="side-card" onClick={() => onNavigate('settings')}>
            <span className="side-card-icon"><Icon name="folder_connection_open" size={18} /></span>
            <span className="side-card-text"><strong>Network</strong><small>{d.dns.mode} · {d.dns.ok ? 'ready' : 'needs attention'}</small></span>
          </button>
          <p className="side-note">Warnings appear here before they become a failed request.</p>
        </>
      )}
    </>
  )
}

function NodeSidebar({ r }: { r: Resource<NodeVersionsInfo> }) {
  const info = r.data
  return (
    <>
      {r.error && <SideAlert>{r.error}</SideAlert>}
      {r.loading && !info && <SideSkeleton rows={3} />}
      {info && (
        <>
          <div className="side-current">
            <span className="side-current-icon"><Icon name="folder_config_open" size={20} /></span>
            <div>
              <span className="side-label">nvm default</span>
              <strong>{info.defaultVersion || 'not set'}</strong>
              <span className="side-current-sub">{info.nvm ? `${info.versions.length} installed` : 'nvm not installed'}</span>
            </div>
            <span className={`status-dot ${info.nvm && info.defaultVersion ? 'ok' : 'warn'}`} />
          </div>
          <ul className="side-list">
            {info.versions.map((v) => (
              <li key={v.version}>
                <span className="side-item static">
                  <Icon name="folder_config_open" size={15} />
                  <span className="side-item-text">
                    <span className="side-item-name">Node {v.version}</span>
                    <span className="side-item-sub">npm {v.npm ?? '—'}{v.sites.length ? ` · ${v.sites.length} site${v.sites.length === 1 ? '' : 's'}` : ''}</span>
                  </span>
                  {v.isDefault && <Glyph name="check" size={12} className="side-item-icon" />}
                </span>
              </li>
            ))}
          </ul>
          <p className="side-note">Versions come from nvm. Pinning one per site writes <code>.nvmrc</code>.</p>
        </>
      )}
    </>
  )
}

function DatabaseSidebar({ r }: { r: Resource<DatabasesInfo> }) {
  const info = r.data
  return (
    <>
      {r.error && <SideAlert>{r.error}</SideAlert>}
      {r.loading && !info && <SideSkeleton rows={3} />}
      {info && (
        <>
          {info.servers.filter((s) => s.installed).map((s) => (
            <div className="side-current" key={s.engine}>
              <span className="side-current-icon"><Icon name="database" size={20} /></span>
              <div>
                <span className="side-label">{s.label}</span>
                <strong>{s.databases.length} {s.databases.length === 1 ? 'database' : 'databases'}</strong>
                <span className="side-current-sub">{s.active ? `running · port ${s.port}` : 'installed · stopped'}</span>
              </div>
              <span className={`status-dot ${s.active ? 'ok' : 'idle'}`} />
            </div>
          ))}
          {info.servers.every((s) => !s.installed) && <SideEmpty>No database engine installed.</SideEmpty>}
          {info.servers.some((s) => !s.installed) && (
            <p className="side-note">
              Not installed: {info.servers.filter((s) => !s.installed).map((s) => s.label).join(', ')}.
              The page has install guides.
            </p>
          )}
          <div className="side-group-label">SQLite</div>
          {info.sqlite.length === 0
            ? <SideEmpty>No SQLite files in your sites.</SideEmpty>
            : (
              <ul className="side-list">
                {info.sqlite.map((f) => (
                  <li key={f.file}>
                    <span className="side-item static">
                      <Icon name="folder_home_open" size={15} />
                      <span className="side-item-text">
                        <span className="side-item-name">{f.site}</span>
                        <span className="side-item-sub">{f.file.split('/').pop()}</span>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          <p className="side-note">Credentials are stored in the panel with permissions 0600.</p>
        </>
      )}
    </>
  )
}

function SettingsSidebar({ onAppearance }: { onAppearance: () => void }) {
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <>
      <button className="side-card" onClick={() => jump('settings-domain')}>
        <span className="side-card-icon"><Icon name="folder_connection_open" size={18} /></span>
        <span className="side-card-text"><strong>Domain</strong><small>Suffix for every site</small></span>
      </button>
      <button className="side-card" onClick={() => jump('settings-parked')}>
        <span className="side-card-icon"><Icon name="folder_home_open" size={18} /></span>
        <span className="side-card-text"><strong>Parked folders</strong><small>Folders served automatically</small></span>
      </button>
      <button className="side-card" onClick={() => jump('settings-runtime')}>
        <span className="side-card-icon"><Icon name="php" size={18} /></span>
        <span className="side-card-text"><strong>Default versions</strong><small>PHP and Node.js</small></span>
      </button>
      <button className="side-card" onClick={() => jump('settings-locations')}>
        <span className="side-card-icon"><Icon name="folder_config_open" size={18} /></span>
        <span className="side-card-text"><strong>Locations</strong><small>Where the panel keeps data</small></span>
      </button>
      <button className="side-card" onClick={onAppearance}>
        <span className="side-card-icon"><Icon name="settings" size={18} /></span>
        <span className="side-card-text"><strong>Appearance</strong><small>Theme, palette, font and size</small></span>
      </button>
      <p className="side-note">Settings apply to this machine. Project files stay in each site.</p>
    </>
  )
}

function PortsSidebar({ r, onNavigate }: { r: Resource<PortsInfo>; onNavigate: () => void }) {
  const info = r.data
  const conflicts = info ? portConflicts(info) : 0
  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    onNavigate()
  }
  return (
    <>
      {r.error && <SideAlert>{r.error}</SideAlert>}
      {r.loading && !info && <SideSkeleton rows={3} />}
      {info && (
        <>
          <button className="side-card" onClick={() => jump('ports-nginx')}>
            <span className="side-card-icon"><Icon name="nginx" size={18} /></span>
            <span className="side-card-text">
              <strong>Valet · nginx</strong>
              <small>HTTP {info.config.http} · HTTPS {info.config.https}</small>
            </span>
            <span className={`status-dot ${info.nginxActive ? 'ok' : 'idle'}`} title={info.nginxActive ? 'Running' : 'Stopped'} />
          </button>
          <button className="side-card" onClick={() => jump('ports-apache')}>
            <span className="side-card-icon"><Icon name="folder_server_open" size={18} /></span>
            <span className="side-card-text">
              <strong>Apache</strong>
              <small>{info.apache.installed ? (info.apache.active ? 'running' : 'stopped') : 'not installed'}</small>
            </span>
            {info.apache.installed && <span className={`status-dot ${info.apache.active ? 'ok' : 'idle'}`} title={info.apache.active ? 'Running' : 'Stopped'} />}
          </button>
          <button className="side-card" onClick={() => jump('ports-usage')}>
            <span className="side-card-icon"><Glyph name="ports" size={18} /></span>
            <span className="side-card-text">
              <strong>Port usage</strong>
              <small>{info.usage.length} listening · {conflicts} conflicts</small>
            </span>
            {conflicts > 0
              ? <span className="side-count warn">{conflicts}</span>
              : <span className="status-dot ok" title="No conflicts" />}
          </button>
          <p className="side-note">Changes are validated with <code>nginx -t</code> and rolled back if they fail.</p>
        </>
      )}
    </>
  )
}

function ServicesSidebar({ r, selected, onSelect }: {
  r: Resource<Service[]>
  selected: string | null
  onSelect: (name: string) => void
}) {
  const all = r.data ?? []
  const active = all.filter((s) => s.active).length
  return (
    <>
      {r.error && <SideAlert>{r.error}</SideAlert>}
      {r.loading && !r.data && <SideSkeleton rows={6} />}
      {r.data && (
        <ul className="side-list">
          {all.map((s) => (
            <li key={s.name}>
              <button className={`side-item ${selected === s.name ? 'selected' : ''}`} onClick={() => onSelect(s.name)}>
                <Icon name={serviceIcon(s.name)} size={17} />
                <span className="side-item-text">
                  <span className="side-item-name">{s.name}</span>
                  <span className="side-item-sub">{s.active ? 'running' : 'stopped'}</span>
                </span>
                <span className={`status-dot ${s.active ? 'ok' : 'idle'}`} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {r.data?.length === 0 && <SideEmpty>No recognized services.</SideEmpty>}
      {all.length > 0 && (
        <div className="side-summary">
          <span>{active} running</span>
          <span>{all.length - active} stopped</span>
        </div>
      )}
      <p className="side-note">Actions use <code>systemctl</code> and may ask for permissions.</p>
    </>
  )
}

function ActivityBar({ tab, badges, onSelect, onSettings }: {
  tab: Tab
  badges: Partial<Record<Tab, string>>
  onSelect: (tab: Tab) => void
  onSettings: () => void
}) {
  return (
    <nav className="rail" aria-label="Activities">
      <button className="rail-brand" onClick={() => onSelect('dashboard')} title="Valet Deck · Laravel local development" aria-label="Go to Dashboard">
        <BrandLogo size={30} />
      </button>
      <div className="rail-group">
        {SECTIONS.map((s, i) => (
          <button
            key={s.id}
            className={`rail-btn ${tab === s.id ? 'active' : ''}`}
            onClick={() => onSelect(s.id)}
            aria-current={tab === s.id ? 'page' : undefined}
            aria-label={`${s.label} (Ctrl+${i + 1})`}
            data-tip={`${s.label}  ·  Ctrl+${i + 1}`}
          >
            <Glyph name={s.icon} size={19} />
            <span className="rail-label">{s.label}</span>
            {badges[s.id] && <span className="rail-badge">{badges[s.id]}</span>}
          </button>
        ))}
      </div>
      <div className="rail-bottom">
        <button className={`rail-btn ${tab === 'settings' ? 'active' : ''}`} onClick={onSettings} aria-current={tab === 'settings' ? 'page' : undefined} aria-label="Settings (Ctrl+,)" data-tip="Settings  ·  Ctrl+,">
          <Glyph name="settings" size={19} />
          <span className="rail-label">Settings</span>
        </button>
      </div>
    </nav>
  )
}

function StatusBar({ section, sites, php, ports, services, mail, mode, onToggleTheme }: {
  section: string
  sites?: Site[]
  php?: PhpInfo
  ports?: PortsInfo
  services?: Service[]
  mail?: MailInfo
  mode: 'light' | 'dark'
  onToggleTheme: () => void
}) {
  const activeServices = services?.filter((s) => s.active).length
  return (
    <footer className="statusbar">
      <div className="status-group">
        <span className="status-item status-brand" title="Laravel local development environment">
          <span className="status-dot accent" />Laravel<span className="status-env">local</span>
        </span>
        <span className="status-sep" aria-hidden="true" />
        <span className="status-item">{section}</span>
      </div>
      <div className="status-group">
        {php && <span className="status-item" title="PHP version in use">PHP {php.current}</span>}
        {ports && (
          <span className="status-item" title="nginx status">
            <span className={`status-dot ${ports.nginxActive ? 'ok' : 'idle'}`} />nginx
          </span>
        )}
        {ports && <span className="status-item status-optional" title="HTTP/HTTPS ports">{ports.config.http}/{ports.config.https}</span>}
        {sites && <span className="status-item status-optional">{sites.length} {sites.length === 1 ? 'site' : 'sites'}</span>}
        {services && <span className="status-item status-optional">{activeServices}/{services.length} services</span>}
        {mail && (
          <span className="status-item" title={mail.running ? 'Built-in catcher receiving mail' : 'Mail catcher stopped'}>
            <span className={`status-dot ${mail.running ? 'ok' : 'idle'}`} />Mail{mail.running ? ` :${mail.port}` : ''}
          </span>
        )}
        <button
          className="status-btn"
          onClick={onToggleTheme}
          title={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          <Glyph name={mode === 'dark' ? 'sun' : 'moon'} size={13} />
        </button>
      </div>
    </footer>
  )
}

function Sites({ r, query, selected, onSelect, onCreate, onChanged }: {
  r: Resource<Site[]>
  query: string
  selected: string | null
  onSelect: (name: string) => void
  onCreate: () => void
  onChanged: () => void
}) {
  const a = useAction(r.reload)
  const [deleting, setDeleting] = useState<Site | null>(null)
  const refs = useRef(new Map<string, HTMLLIElement>())
  const all = r.data ?? []
  const q = query.trim().toLowerCase()
  const filtered = q ? all.filter((s) => s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q)) : all
  const secure = all.filter((s) => s.secure).length

  useEffect(() => {
    if (!selected) return
    refs.current.get(selected)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [selected, r.data])

  return (
    <>
      <Page
        title="Sites"
        hint="Folders served by Valet (parked and linked). Create Laravel projects, enable HTTPS, open or delete each site."
        error={r.error || a.error}
        loading={r.loading}
        onRefresh={r.reload}
        actions={
          <button className="btn primary" onClick={onCreate}>
            <Glyph name="plus" size={14} />New project
          </button>
        }
      >
      {r.loading && !r.data && <RowsSkeleton />}
      {r.data?.length === 0 && (
        <EmptyState icon="sites" title="No sites yet">
          Create one with <strong>New project</strong> or run <code>valet park</code> inside your
          projects folder to serve them here.
        </EmptyState>
      )}
      {r.data && r.data.length > 0 && (
        <>
          <div className="list-bar">
            <span>{q ? `${filtered.length} of ${all.length} sites` : `${all.length} ${all.length === 1 ? 'site' : 'sites'}`}</span>
            <span>{secure} with HTTPS</span>
          </div>
          {filtered.length === 0
            ? <EmptyState icon="search" title="No matches">No sites match “{query}”.</EmptyState>
            : (
              <ul className="rows">
                {filtered.map((s) => (
                  <li
                    key={s.name}
                    ref={(el) => { if (el) refs.current.set(s.name, el); else refs.current.delete(s.name) }}
                    className={selected === s.name ? 'selected' : ''}
                  >
                    <button type="button" className="row-main row-link" onClick={() => onSelect(s.name)} title={`Open ${s.name} details`}>
                      <span className="row-icon"><Icon name={s.kind === 'linked' ? 'folder_link_open' : 'folder_home_open'} size={18} /></span>
                      <div className="row-text"><strong>{s.name}</strong><small>{s.path}</small></div>
                    </button>
                    <div className="row-meta">
                      <span className="tag">{s.kind}</span>
                      {s.secure && <span className="tag on"><Glyph name="lock" size={11} />HTTPS</span>}
                    </div>
                    <div className="row-actions">
                      <button
                        className="btn"
                        disabled={a.busy || !s.url}
                        title={s.url ? `Open ${s.url} in the browser` : 'Site name cannot be opened in the browser'}
                        onClick={() => a.act(() => window.api.sites.open(s.name))}
                      >
                        <Glyph name="globe" size={13} />
                        Open
                      </button>
                      <button className="btn" disabled={a.busy} onClick={() => a.act(() => window.api.sites.secure(s.name, !s.secure))}>
                        <Glyph name={s.secure ? 'unlock' : 'lock'} size={13} />
                        {s.secure ? 'Disable HTTPS' : 'Enable HTTPS'}
                      </button>
                      <button
                        className="btn ghost row-delete"
                        disabled={a.busy}
                        title={`Delete ${s.name}`}
                        onClick={() => setDeleting(s)}
                      >
                        <Glyph name="close" size={13} />
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </>
      )}
      </Page>
      {deleting && (
        <DeleteSiteDialog
          site={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={onChanged}
        />
      )}
    </>
  )
}

function Ports({ r, onServiceChange }: { r: Resource<PortsInfo>; onServiceChange: () => void }) {
  const a = useAction(r.reload)
  const [http, setHttp] = useState('')
  const [https, setHttps] = useState('')
  const [apacheHttp, setApacheHttp] = useState('')
  const [apacheHttps, setApacheHttps] = useState('')

  useEffect(() => {
    const c = r.data?.config
    if (!c) return
    setHttp(String(c.http))
    setHttps(String(c.https))
  }, [r.data?.config.http, r.data?.config.https]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const apache = r.data?.apache
    if (!apache) return
    setApacheHttp(apache.http == null ? '' : String(apache.http))
    setApacheHttps(apache.https == null ? '' : String(apache.https))
  }, [r.data?.apache.http, r.data?.apache.https]) // eslint-disable-line react-hooks/exhaustive-deps

  const info = r.data
  const mine = new Set(info ? [info.config.http, info.config.https] : [])
  const conflicts = info ? portConflicts(info) : 0
  const valetReady = validWebPort(http) && validWebPort(https) && Number(http) !== Number(https)
  const apacheReady = validWebPort(apacheHttp) && validWebPort(apacheHttps) && Number(apacheHttp) !== Number(apacheHttps)

  return (
    <Page
      title="Ports"
      hint="Change the Valet (nginx) and Apache ports without touching the rest of the network."
      error={r.error || a.error}
      loading={r.loading}
      onRefresh={r.reload}
    >
      {r.loading && !info && <RowsSkeleton rows={3} />}
      {info && (
        <>
          <div className="panel" id="ports-nginx">
            <div className="panel-head">
              <span className="panel-icon"><Icon name="nginx" size={18} /></span>
              <h2 className="panel-title">Valet · nginx</h2>
              <span className={`tag ${info.nginxActive ? 'on' : ''}`}>{info.nginxActive ? 'running' : 'stopped'}</span>
            </div>
            <div className="form-grid">
              <label>HTTP<input type="number" min={1} max={65535} value={http} onChange={(e) => setHttp(e.target.value)} /></label>
              <label>HTTPS<input type="number" min={1} max={65535} value={https} onChange={(e) => setHttps(e.target.value)} /></label>
              <div className="field">
                <span>Presets</span>
                <span className="presets">
                  <button type="button" className="btn" onClick={() => { setHttp('80'); setHttps('443') }}>80 / 443</button>
                  <button type="button" className="btn" onClick={() => { setHttp('8080'); setHttps('8443') }}>8080 / 8443</button>
                </span>
              </div>
            </div>
            <div className="panel-actions">
              <button className="btn primary" disabled={a.busy || !valetReady} onClick={() => a.act(() => window.api.ports.set(Number(http), Number(https)))}>
                <Glyph name="check" size={14} />Save and reload nginx
              </button>
            </div>
            <p className="panel-note">
              Validates the configuration with <code>nginx -t</code>, keeps copies in <code>~/.valet-studio/backups</code> and restores the previous one if anything fails.
              With custom ports, open your sites as <code>site.test:{http || '…'}</code>. Ports reserved for DNS/DHCP/NTP/mDNS (53, 67, 68, 123, 5353) are not allowed.
            </p>
          </div>

          <div className="panel" id="ports-apache">
            <div className="panel-head">
              <span className="panel-icon"><Icon name="folder_server_open" size={18} /></span>
              <h2 className="panel-title">Apache</h2>
              {info.apache.installed
                ? <span className={`tag ${info.apache.active ? 'on' : ''}`}>{info.apache.active ? 'running' : info.apache.enabled ? 'stopped (starts at boot)' : 'stopped'}</span>
                : <span className="tag">not installed</span>}
            </div>
            {info.apache.installed ? (
              <>
                <div className="form-grid">
                  <label>HTTP<input type="number" min={1} max={65535} value={apacheHttp} onChange={(e) => setApacheHttp(e.target.value)} /></label>
                  <label>HTTPS<input type="number" min={1} max={65535} value={apacheHttps} onChange={(e) => setApacheHttps(e.target.value)} /></label>
                  <div className="field">
                    <span>Presets</span>
                    <span className="presets">
                      <button type="button" className="btn" onClick={() => { setApacheHttp('8080'); setApacheHttps('8443') }}>8080 / 8443</button>
                      <button type="button" className="btn" onClick={() => { setApacheHttp('80'); setApacheHttps('443') }}>80 / 443</button>
                    </span>
                  </div>
                </div>
                <div className="panel-actions">
                  <button className="btn primary" disabled={a.busy || !apacheReady} onClick={() => a.act(() => window.api.ports.setApache(Number(apacheHttp), Number(apacheHttps)))}>
                    <Glyph name="check" size={14} />Save and reload Apache
                  </button>
                  <button className="btn" disabled={a.busy} onClick={() => a.act(async () => {
                    await window.api.services.action('apache2', info.apache.active ? 'stop' : 'start')
                    onServiceChange()
                  })}>
                    <Glyph name={info.apache.active ? 'stop' : 'play'} size={12} />
                    {info.apache.active ? 'Stop Apache' : 'Start Apache'}
                  </button>
                </div>
                <p className="panel-note">
                  If Apache holds 80/443, move it to 8080/8443 or stop it to free the Valet ports.
                  It is validated with <code>apache2ctl configtest</code> and the previous copy is restored if it fails.
                </p>
              </>
            ) : (
              <p className="panel-note">Apache was not found in <code>/etc/apache2</code>. Valet uses nginx and does not need Apache.</p>
            )}
          </div>

          <div id="ports-usage" className="usage-block">
            <div className="section-head">
              <h2>Listening ports</h2>
              <span>{info.usage.length} processes · {conflicts} conflicts</span>
            </div>
            <ul className="rows">
              {info.usage.map((u) => {
                const hiddenNginx = u.process === '—' && mine.has(u.port) && info.nginxActive
                const proc = hiddenNginx ? 'nginx' : u.process
                const conflict = mine.has(u.port) && proc !== 'nginx'
                return (
                  <li key={u.port} className={conflict ? 'conflict' : ''}>
                    <div className="row-main">
                      <span className="row-icon"><Icon name={portIcon(u)} size={18} /></span>
                      <div className="row-text"><strong>:{u.port}</strong><small>{KNOWN[u.port] ?? 'Other service'}</small></div>
                    </div>
                    <div className="row-meta">
                      {mine.has(u.port) && proc === 'nginx' && <span className="tag on">Valet</span>}
                      {conflict && <span className="tag warn"><Glyph name="alert" size={11} />conflicts with Valet</span>}
                    </div>
                    <div className="row-actions">
                      <span className="proc">{proc}{u.pid && <small>pid {u.pid}</small>}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        </>
      )}
    </Page>
  )
}

/** Journal de una unidad, en solo lectura. Se pide al abrir el panel. */
function ServiceLogPanel({ name, onClose }: { name: string; onClose: () => void }) {
  const r = useResource(() => window.api.services.logs(name, 200), true)
  const text = r.data?.trim() ?? ''
  return (
    <Panel
      icon={<Glyph name="terminal" size={16} />}
      title={`${name} log`}
      tag={
        <button className="btn ghost btn-mini" onClick={r.reload} disabled={r.loading}>
          <Glyph name="refresh" size={12} className={r.loading ? 'spin' : ''} />Refresh
        </button>
      }
    >
      {r.error && <Notice tone="warn">{r.error}</Notice>}
      {r.loading && r.data === undefined && <RowsSkeleton rows={2} />}
      {r.data !== undefined && (
        text
          ? <pre className="log">{text}</pre>
          : <p className="panel-note">systemd has no recent entries for this unit. If it only just started, try again in a moment.</p>
      )}
      <div className="panel-actions">
        <button className="btn ghost" onClick={onClose}>Close log</button>
      </div>
    </Panel>
  )
}

function Services({ r, selected, onChanged }: {
  r: Resource<Service[]>
  selected: string | null
  onChanged: () => void
}) {
  const a = useAction(onChanged)
  const refs = useRef(new Map<string, HTMLLIElement>())
  const [logFor, setLogFor] = useState<string | null>(null)
  const all = r.data ?? []
  const active = all.filter((s) => s.active).length

  useEffect(() => {
    if (!selected) return
    refs.current.get(selected)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [selected, r.data])

  return (
    <Page
      title="Services"
      hint="nginx, Apache, dnsmasq, php-fpm, MySQL/MariaDB, Redis and PostgreSQL via systemctl."
      error={r.error || a.error}
      loading={r.loading}
      onRefresh={r.reload}
    >
      {r.loading && !r.data && <RowsSkeleton rows={5} />}
      {r.data && (
        <>
          <div className="list-bar">
            <span>{all.length} services</span>
            <span>{active} running</span>
          </div>
          {all.length === 0
            ? <EmptyState icon="services" title="No recognized services">Check that systemd is available and Valet is installed.</EmptyState>
            : (
              <ul className="rows">
                {all.map((s) => (
                  <li
                    key={s.name}
                    ref={(el) => { if (el) refs.current.set(s.name, el); else refs.current.delete(s.name) }}
                    className={selected === s.name ? 'selected' : ''}
                  >
                    <div className="row-main">
                      <span className="row-icon"><Icon name={serviceIcon(s.name)} size={18} /></span>
                      <div className="row-text"><strong>{s.name}</strong><small>{s.active ? 'running' : 'stopped'}</small></div>
                    </div>
                    <div className="row-meta">
                      <span className={`tag ${s.active ? 'on' : ''}`}>{s.active ? 'running' : 'stopped'}</span>
                    </div>
                    <div className="row-actions">
                      <button className="btn" disabled={a.busy} onClick={() => setLogFor((v) => (v === s.name ? null : s.name))}>
                        <Glyph name="terminal" size={13} />
                        {logFor === s.name ? 'Hide log' : 'Logs'}
                      </button>
                      <button className="btn" disabled={a.busy} onClick={() => a.act(() => window.api.services.action(s.name, s.active ? 'stop' : 'start'))}>
                        <Glyph name={s.active ? 'stop' : 'play'} size={12} />
                        {s.active ? 'Stop' : 'Start'}
                      </button>
                      <button className="btn" disabled={a.busy || !s.active} onClick={() => a.act(() => window.api.services.action(s.name, 'restart'))}>
                        <Glyph name="restart" size={12} />Restart
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          {logFor && <ServiceLogPanel name={logFor} onClose={() => setLogFor(null)} />}
        </>
      )}
    </Page>
  )
}

function Shell({ settings, setSettings, mode, initialTab = 'dashboard' }: {
  settings: Settings
  setSettings: (patch: Partial<Settings>) => void
  mode: 'light' | 'dark'
  initialTab?: Tab
}) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 901px)').matches)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY))
      return Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT
    } catch {
      return SIDEBAR_DEFAULT
    }
  })
  const widthRef = useRef(sidebarWidth)
  const [siteQuery, setSiteQuery] = useState('')
  const [selectedSite, setSelectedSite] = useState<string | null>(null)
  const [selectedService, setSelectedService] = useState<string | null>(null)

  const sites = useResource(() => window.api.sites.list())
  const php = useResource(() => window.api.php.list())
  const dashboard = useResource(() => window.api.system.dashboard(), tab === 'dashboard')
  const node = useResource(() => window.api.node.versions(), tab === 'node')
  const databases = useResource(() => window.api.databases.info(), tab === 'database')
  const systemSettings = useResource(() => window.api.system.settings(), tab === 'settings')
  const ports = useResource(() => window.api.ports.scan(), tab === 'ports')
  const services = useResource(() => window.api.services.list(), tab === 'services')
  const env = useResource(() => window.api.install.check(), tab === 'settings')
  const mail = useResource(() => window.api.mail.info())
  const [mailInbox, setMailInbox] = useState<string | null>(null)
  const [selectedMail, setSelectedMail] = useState<string | null>(null)
  const previousTab = useRef(tab)

  useEffect(() => window.api.mail.onEvent(() => mail.reload()), [mail.reload])

  useEffect(() => {
    if (previousTab.current === tab) return
    previousTab.current = tab
    if (tab === 'sites') sites.reload()
    else if (tab === 'php') php.reload()
    else if (tab === 'mail') mail.reload()
  }, [tab, sites.reload, php.reload, mail.reload])

  const section = tab === 'settings'
    ? { id: 'settings' as const, label: 'Settings', icon: 'settings' as const, hint: 'Domain, parked folders, default versions and where the panel keeps its data.' }
    : SECTIONS.find((s) => s.id === tab) ?? SECTIONS[0]
  const databaseTotal = databases.data
    ? databases.data.servers.reduce((sum, s) => sum + s.databases.length, 0)
    : undefined

  // Insignia de la cabecera del panel lateral. A diferencia del rail, aquí sí
  // interesa ver el puerto completo o un cero de correo: es el contexto de la
  // sección abierta.
  const sideBadge = tab === 'dashboard' && dashboard.data && (dashboard.data.warnings.length > 0 || !dashboard.data.web.ready)
    ? String(dashboard.data.warnings.length + (dashboard.data.web.ready ? 0 : 1))
    : tab === 'sites' && sites.data
      ? String(sites.data.length)
      : tab === 'php' && php.data
        ? php.data.current
        : tab === 'node' && node.data
          ? node.data.defaultVersion ?? undefined
          : tab === 'database' && databaseTotal !== undefined
            ? String(databaseTotal)
            : tab === 'ports' && ports.data
              ? `${ports.data.config.http}/${ports.data.config.https}`
              : tab === 'services' && services.data
                ? `${services.data.filter((s) => s.active).length}/${services.data.length}`
                : tab === 'mail' && mail.data
                  ? (mail.data.running ? String(mail.data.messages ?? 0) : 'off')
                  : undefined

  const badges: Partial<Record<Tab, string>> = {}
  // El Dashboard ya trae estas cifras en una sola llamada: se usan como valor
  // inicial para que el rail esté completo sin visitar cada sección. Al abrir
  // una sección, su recurso propio refresca la insignia.
  if (dashboard.data) {
    const d = dashboard.data
    const webBadge = d.web.ready ? 0 : 1
    if (d.warnings.length || webBadge) badges.dashboard = String(d.warnings.length + webBadge)
    if (d.sites > 0) badges.sites = String(d.sites)
    if (d.php.version) badges.php = d.php.version
    if (d.node.version) badges.node = d.node.version.split('.')[0]
    const databaseCount = d.databases.reduce((sum, s) => sum + s.databases, 0)
    if (databaseCount > 0) badges.database = String(databaseCount)
    if (d.services.length) {
      badges.services = `${d.services.filter((s) => s.active).length}/${d.services.length}`
    }
    if (d.mail.running && d.mail.messages > 0) badges.mail = String(d.mail.messages)
  }
  if (sites.data?.length) badges.sites = String(sites.data.length)
  if (php.data?.current) badges.php = php.data.current
  if (node.data?.defaultVersion) badges.node = node.data.defaultVersion.split('.')[0]
  if (databaseTotal !== undefined) badges.database = String(databaseTotal)
  if (ports.data) badges.ports = String(ports.data.config.http)
  if (services.data) badges.services = `${services.data.filter((s) => s.active).length}/${services.data.length}`
  if (mail.data?.running && mail.data.messages > 0) badges.mail = String(mail.data.messages)

  const activeResource: Resource<unknown> = tab === 'dashboard'
    ? dashboard
    : tab === 'sites'
      ? sites
      : tab === 'php'
        ? php
        : tab === 'node'
          ? node
          : tab === 'database'
            ? databases
            : tab === 'settings'
              ? systemSettings
              : tab === 'ports'
                ? ports
                : tab === 'services'
                  ? services
                  : mail
  const loading = activeResource.loading
  const reload = activeResource.reload

  const refreshSiteViews = useCallback(() => {
    sites.reload()
    if (dashboard.data) dashboard.reload()
    if (php.data) php.reload()
    if (node.data) node.reload()
    if (databases.data) databases.reload()
  }, [
    sites.reload, dashboard.data, dashboard.reload, php.data, php.reload,
    node.data, node.reload, databases.data, databases.reload
  ])

  const refreshServicesAndPorts = useCallback(() => {
    if (services.data) services.reload()
    if (ports.data) ports.reload()
  }, [services.data, services.reload, ports.data, ports.reload])

  const closeOnMobile = () => {
    if (window.matchMedia('(max-width: 900px)').matches) setSidebarOpen(false)
  }

  const pickSite = (name: string) => {
    setSelectedSite(name)
    closeOnMobile()
  }

  const pickService = (name: string) => {
    setSelectedService(name)
    closeOnMobile()
  }

  const selectTab = (id: Tab) => {
    if (id === tab) {
      setSidebarOpen((v) => !v)
      return
    }
    setTab(id)
    setSidebarOpen(true)
  }

  /** Navegación desde el contenido: no abre el panel lateral en pantallas pequeñas. */
  const go = (id: Tab) => {
    setTab(id)
    if (window.matchMedia('(max-width: 900px)').matches) setSidebarOpen(false)
  }

  const openSettings = () => {
    setTab('settings')
    setSidebarOpen(true)
  }

  const toggleTheme = () => setSettings({ mode: mode === 'dark' ? 'light' : 'dark' })

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (window.matchMedia('(max-width: 900px)').matches) return
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    document.body.classList.add('resizing')
    const move = (ev: PointerEvent) => {
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(startW + ev.clientX - startX)))
      widthRef.current = next
      setSidebarWidth(next)
    }
    const stop = () => {
      document.body.classList.remove('resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      try { localStorage.setItem(WIDTH_KEY, String(widthRef.current)) } catch { /* sin almacenamiento */ }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 901px)')
    const onChange = (e: MediaQueryListEvent) => setSidebarOpen(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cualquier diálogo abierto (incluidos los de correo) se queda con el
      // teclado: si no, Ctrl+B o Ctrl+1 cambiaban la vista por detrás.
      if (settingsOpen || createOpen || modalsOpen()) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setSidebarOpen((v) => !v)
        return
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        openSettings()
        return
      }
      if (mod && /^[1-9]$/.test(e.key)) {
        const index = Number(e.key) - 1
        if (SECTIONS[index]) {
          e.preventDefault()
          setTab(SECTIONS[index].id)
        }
        return
      }
      if (e.key === 'Escape' && window.matchMedia('(max-width: 900px)').matches) setSidebarOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, createOpen])

  return (
    <IconProvider theme={settings.iconTheme} mode={mode}>
      <div
        className={`shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}
        style={{ '--sidebar-w': `${sidebarWidth}px` } as CSSProperties}
      >
        <ActivityBar tab={tab} badges={badges} onSelect={selectTab} onSettings={openSettings} />
        <Sidebar
          title={section.label}
          badge={sideBadge}
          onRefresh={reload}
          loading={loading}
          onHide={() => setSidebarOpen(false)}
          open={sidebarOpen}
          onResizeStart={startResize}
        >
          {tab === 'dashboard' && <DashboardSidebar r={dashboard} onNavigate={go} />}
          {tab === 'sites' && <SitesSidebar r={sites} query={siteQuery} setQuery={setSiteQuery} selected={selectedSite} onSelect={pickSite} />}
          {tab === 'php' && <PhpSidebar r={php} />}
          {tab === 'node' && <NodeSidebar r={node} />}
          {tab === 'database' && <DatabaseSidebar r={databases} />}
          {tab === 'settings' && <SettingsSidebar onAppearance={() => setSettingsOpen(true)} />}
          {tab === 'ports' && <PortsSidebar r={ports} onNavigate={closeOnMobile} />}
          {tab === 'services' && <ServicesSidebar r={services} selected={selectedService} onSelect={pickService} />}
          {tab === 'mail' && (
            <MailSidebar
              r={mail}
              inbox={mailInbox}
              onInbox={setMailInbox}
              selected={selectedMail}
              onSelect={(id) => {
                setSelectedMail(id)
                // En ventanas estrechas la lista es una capa sobre el detalle:
                // al elegir un mensaje se cierra para dejar verlo entero.
                if (id && !window.matchMedia('(min-width: 901px)').matches) setSidebarOpen(false)
              }}
            />
          )}
        </Sidebar>
        <div className="workarea">
          <header className="editorbar">
            <button
              className="icon-btn"
              onClick={() => setSidebarOpen((v) => !v)}
              aria-pressed={sidebarOpen}
              aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              title="Toggle panel (Ctrl+B)"
            >
              <Glyph name="panel" size={17} />
            </button>
            <div className="crumbs">
              <span className="crumb-root">Valet</span>
              <Glyph name="chevron" size={11} className="crumb-sep" />
              <span className="crumb-current"><Glyph name={section.icon} size={14} />{section.label}</span>
              {tab === 'sites' && selectedSite && (
                <>
                  <Glyph name="chevron" size={11} className="crumb-sep" />
                  <span className="crumb-current">{selectedSite}</span>
                </>
              )}
            </div>
            <span className="kbd-hint" aria-hidden="true"><kbd>Ctrl</kbd><kbd>B</kbd></span>
          </header>
          <main className={`editor ${tab === 'mail' ? 'mail-editor' : ''}`}>
            {tab === 'dashboard' && <Dashboard r={dashboard} onNavigate={go} onCreate={() => setCreateOpen(true)} />}
            {tab === 'sites' && (
              selectedSite
                ? (
                  <SiteDetail
                    name={selectedSite}
                    onClose={() => setSelectedSite(null)}
                    onNavigate={go}
                    onOpen={(name) => { void window.api.sites.open(name) }}
                    onSitesChanged={refreshSiteViews}
                  />
                )
                : <Sites r={sites} query={siteQuery} selected={selectedSite} onSelect={pickSite} onCreate={() => setCreateOpen(true)} onChanged={refreshSiteViews} />
            )}
            {tab === 'php' && <PhpVersions onChanged={refreshSiteViews} />}
            {tab === 'node' && <NodeVersions r={node} onChanged={refreshSiteViews} />}
            {tab === 'database' && <DatabasePage r={databases} onNavigate={go} />}
            {tab === 'settings' && <SettingsPage r={systemSettings} env={env} onAppearance={() => setSettingsOpen(true)} onNavigate={go} />}
            {tab === 'ports' && <Ports r={ports} onServiceChange={refreshServicesAndPorts} />}
            {tab === 'services' && <Services r={services} selected={selectedService} onChanged={refreshServicesAndPorts} />}
            {tab === 'mail' && (
              <MailPage r={mail} id={selectedMail} inbox={mailInbox} onSelect={setSelectedMail} />
            )}
          </main>
        </div>
        <StatusBar
          section={section.label}
          sites={sites.data}
          php={php.data}
          ports={ports.data}
          services={services.data}
          mail={mail.data}
          mode={mode}
          onToggleTheme={toggleTheme}
        />
        {sidebarOpen && <button className="scrim" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} tabIndex={-1} />}
        {settingsOpen && <SettingsDialog s={settings} set={setSettings} onClose={() => setSettingsOpen(false)} />}
        {createOpen && (
          <CreateProjectDialog
            onClose={() => setCreateOpen(false)}
            onCreated={(site) => {
              setSelectedSite(site.name)
              setTab('sites')
              sites.reload()
            }}
          />
        )}
      </div>
    </IconProvider>
  )
}

/**
 * Puerta de arranque: comprueba los componentes antes de montar la app.
 *
 * El instalador solo aparece cuando falta un componente requerido. No depende
 * de `localStorage`: una máquina que ya tiene PHP, Composer, nginx y Valet
 * entra directa aunque sea el primer arranque del panel. «Set up later» sigue
 * disponible y, si sigue faltando algo, la ventana vuelve al siguiente arranque.
 *
 * La ventana usa `skipDns` y no toca el DNS existente.
 */
export default function App() {
  const [settings, setSettings] = useSettings()
  const mode = useResolvedMode(settings.mode)
  const [boot, setBoot] = useState<'checking' | 'setup' | 'app' | 'error'>('checking')
  const [bootEnv, setBootEnv] = useState<Env>()
  const [bootTab, setBootTab] = useState<Tab>('dashboard')
  const [bootError, setBootError] = useState('')

  const check = useCallback(async () => {
    setBoot('checking')
    setBootError('')
    try {
      const env = await window.api.install.check()
      setBootEnv(env)
      setBoot(setupNeeded(env) ? 'setup' : 'app')
    } catch (e) {
      setBootError(errorMessage(e))
      setBoot('error')
    }
  }, [])

  useEffect(() => { void check() }, [check])

  const finish = (tab: Tab = 'dashboard') => {
    setBootTab(tab)
    setBoot('app')
  }

  const bootFrame = (children: ReactNode) => (
    <IconProvider theme={settings.iconTheme} mode={mode}>
      <div className="setup-shell">
        <div className="setup-card setup-boot">{children}</div>
      </div>
    </IconProvider>
  )

  if (boot === 'checking') {
    return bootFrame(
      <>
        <BrandLockup size={44} />
        <h1>Checking your setup…</h1>
        <p className="setup-lead">Looking for PHP, Composer, nginx and Laravel Valet.</p>
      </>
    )
  }

  if (boot === 'error') {
    return bootFrame(
      <>
        <BrandLockup size={44} />
        <h1>Could not check your setup</h1>
        <p className="setup-lead">{bootError}</p>
        <div className="setup-actions">
          <button type="button" className="btn primary" onClick={() => void check()}>
            <Glyph name="refresh" size={13} />Try again
          </button>
          <button type="button" className="btn ghost" onClick={() => setBoot('app')}>Open anyway</button>
        </div>
      </>
    )
  }

  if (boot === 'setup' && bootEnv) {
    return (
      <IconProvider theme={settings.iconTheme} mode={mode}>
        <SetupScreen env={bootEnv} onOpen={finish} onSkip={finish} />
      </IconProvider>
    )
  }

  return <Shell settings={settings} setSettings={setSettings} mode={mode} initialTab={bootTab} />
}
