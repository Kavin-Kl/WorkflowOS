import { useEffect, useState } from 'react'
import { api, useLive } from './api'
import type { AppStatus, Workflow } from '../electron/shared/types'
import Observe from './pages/Observe'
import Discover from './pages/Discover'
import Workflows from './pages/Workflows'
import Settings from './pages/Settings'
import { Toaster } from './components/Toast'

export type Page = 'observe' | 'discover' | 'workflows' | 'settings'

export default function App() {
  const [page, setPage] = useState<Page>('observe')
  const [focusWorkflow, setFocusWorkflow] = useState<string | null>(null)
  const [status] = useLive<AppStatus | null>(() => api.getStatus(), ['status', 'activity', 'pattern', 'workflow'], null)
  const [workflows] = useLive<Workflow[]>(() => api.listWorkflows(), ['workflow'], [])
  const proposed = workflows.filter((w) => w.status === 'proposed').length

  const openWorkflow = (id: string) => {
    setFocusWorkflow(id)
    setPage('workflows')
  }

  useEffect(() => {
    document.title = 'WorkFlowOS'
  }, [])

  const nav: { id: Page; label: string; step: string; num?: number; hot?: boolean }[] = [
    { id: 'observe', label: 'Observe', step: '01', num: status?.eventCount },
    { id: 'discover', label: 'Discover', step: '02', num: status?.patternCount },
    { id: 'workflows', label: 'Automate', step: '03', num: proposed || status?.activeWorkflows, hot: proposed > 0 },
    { id: 'settings', label: 'Connections & privacy', step: '··' },
  ]

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          Work<b>Flow</b>OS
        </div>
        <div className="brand-sub">Learns your routine. Automates it.</div>
        <nav className="nav">
          {nav.map((n) => (
            <button key={n.id} className={page === n.id ? 'on' : ''} onClick={() => setPage(n.id)}>
              <span className="step">{n.step}</span>
              {n.label}
              {n.num !== undefined && n.num > 0 && <span className={`num ${n.hot ? 'hot' : ''}`}>{n.num}</span>}
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          {status?.sensors.map((s) => (
            <div className="sensor" key={s.name} title={s.detail}>
              <span className={`dot ${s.state}`} />
              <div>
                {s.name}
                <small>{s.detail ?? s.state}</small>
              </div>
            </div>
          ))}
        </div>
      </aside>
      <main className="main">
        {page === 'observe' && <Observe status={status} go={setPage} />}
        {page === 'discover' && <Discover openWorkflow={openWorkflow} go={setPage} />}
        {page === 'workflows' && <Workflows focus={focusWorkflow} onFocus={setFocusWorkflow} />}
        {page === 'settings' && <Settings status={status} />}
      </main>
      <Toaster />
    </div>
  )
}
