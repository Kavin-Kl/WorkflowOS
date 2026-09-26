import { Fragment } from 'react'
import type { LadderRung } from '../../electron/shared/api'
import type { MechanismAttempt, MechanismStat } from '../../electron/shared/types'

const MECH_LABEL: Record<string, string> = {
  api: 'API',
  app: 'App',
  accessibility: 'A11y',
  browser: 'Browser',
  vision: 'Vision',
}

export function StepChain({ signature }: { signature: string[] }) {
  return (
    <div className="chain">
      {signature.map((tok, i) => {
        const [app, ...rest] = tok.split(':')
        return (
          <Fragment key={i}>
            {i > 0 && <span className="arrow">→</span>}
            <span className={`chip app-${app}`}>
              <span className="app">{app}</span> {rest.join(':').replace(/_/g, ' ')}
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}

/**
 * The automation-priority ladder for one action. Shows which mechanisms exist,
 * which one ran, which failed, and which are demoted by learned reliability.
 */
export function Ladder({
  rungs,
  attempts,
  stats,
  action,
}: {
  rungs: LadderRung[]
  attempts?: MechanismAttempt[]
  stats?: MechanismStat[]
  action: string
}) {
  return (
    <div className="ladder">
      {rungs.map((r) => {
        const att = attempts?.find((a) => a.mechanism === r.mechanism)
        const st = stats?.find((s) => s.action === action && s.mechanism === r.mechanism)
        const total = st ? st.successes + st.failures : 0
        const rate = st && total ? st.successes / total : null
        const cls = [
          'rung',
          r.supported && 'sup',
          att?.ok && 'used',
          att && !att.ok && 'failed',
          !att && rate !== null && total >= 3 && rate < 0.4 && 'demoted',
        ]
          .filter(Boolean)
          .join(' ')
        const title = [
          r.via ?? `${MECH_LABEL[r.mechanism]}: not available for this action`,
          att?.error,
          rate !== null ? `${Math.round(rate * 100)}% success over ${total} runs` : '',
        ]
          .filter(Boolean)
          .join('\n')
        return (
          <span key={r.mechanism} className={cls} title={title}>
            {MECH_LABEL[r.mechanism]}
          </span>
        )
      })}
    </div>
  )
}

export function mechLabel(m?: string) {
  return m ? MECH_LABEL[m] ?? m : ''
}
