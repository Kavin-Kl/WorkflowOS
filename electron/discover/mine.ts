import type { PatternOccurrence } from '../shared/types'
import type { Step } from './abstract'

export interface MinedPattern {
  signature: string[]
  occurrences: PatternOccurrence[]
  support: number
  avgDurationMs: number
  apps: string[]
  score: number
}

export interface MineOptions {
  minSupport: number
  minLength: number
  maxLength: number
  /** A gap longer than this starts a new session. */
  sessionGapMs: number
  /** Patterns must span at least this many apps (cross-app workflows only). */
  minApps: number
  /** Max normalized edit distance for two signatures to be treated as variants. */
  similarity: number
}

export const DEFAULT_MINE: MineOptions = {
  minSupport: 3,
  minLength: 3,
  maxLength: 12,
  sessionGapMs: 10 * 60_000,
  minApps: 2,
  similarity: 0.25,
}

const appOf = (token: string) => token.split(':')[0]

/** Split the step stream at idle markers and long gaps. */
export function segment(steps: Step[], gapMs: number): Step[][] {
  const sessions: Step[][] = []
  let cur: Step[] = []
  for (const s of steps) {
    const prev = cur[cur.length - 1]
    if (s.isBreak || (prev && s.ts - prev.ts > gapMs)) {
      if (cur.length) sessions.push(cur)
      cur = []
      if (s.isBreak) continue
    }
    cur.push(s)
  }
  if (cur.length) sessions.push(cur)
  return sessions
}

export function editDistance(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

function isSubsequenceContiguous(small: string[], big: string[]): boolean {
  if (small.length > big.length) return false
  outer: for (let i = 0; i + small.length <= big.length; i++) {
    for (let j = 0; j < small.length; j++) if (big[i + j] !== small[j]) continue outer
    return true
  }
  return false
}

interface Candidate {
  signature: string[]
  occ: { session: number; start: number; end: number }[]
}

/**
 * Find repeated cross-application step sequences.
 *
 * 1. Apriori-style pruning: a token seen fewer than minSupport times cannot be
 *    part of a frequent pattern, so it is removed as noise. That lets patterns
 *    match across one-off interruptions.
 * 2. Count non-overlapping occurrences of every contiguous n-gram per session.
 * 3. Keep maximal patterns, collapse rotations of the same loop, and merge
 *    near-identical variants (edit distance).
 * 4. Score by frequency, time spent, and cross-app transitions.
 */
export function minePatterns(allSteps: Step[], opts: Partial<MineOptions> = {}): MinedPattern[] {
  const o = { ...DEFAULT_MINE, ...opts }

  const freq = new Map<string, number>()
  for (const s of allSteps) if (!s.isBreak) freq.set(s.token, (freq.get(s.token) ?? 0) + 1)
  const pruned = allSteps.filter((s) => s.isBreak || (freq.get(s.token) ?? 0) >= o.minSupport)

  // Re-collapse duplicates exposed by pruning.
  const steps: Step[] = []
  for (const s of pruned) {
    const prev = steps[steps.length - 1]
    if (prev && !s.isBreak && prev.token === s.token) {
      steps[steps.length - 1] = { ...prev, eventIds: [...prev.eventIds, ...s.eventIds] }
    } else steps.push(s)
  }

  const sessions = segment(steps, o.sessionGapMs)

  const cands = new Map<string, Candidate>()
  sessions.forEach((sess, si) => {
    const toks = sess.map((s) => s.token)
    for (let len = o.minLength; len <= Math.min(o.maxLength, toks.length); len++) {
      const lastEnd = new Map<string, number>()
      for (let i = 0; i + len <= toks.length; i++) {
        const sig = toks.slice(i, i + len)
        if (new Set(sig.map(appOf)).size < o.minApps) continue
        const key = sig.join('>')
        if ((lastEnd.get(key) ?? -1) >= i) continue // overlapping occurrence
        lastEnd.set(key, i + len - 1)
        let c = cands.get(key)
        if (!c) cands.set(key, (c = { signature: sig, occ: [] }))
        c.occ.push({ session: si, start: i, end: i + len - 1 })
      }
    }
  })

  let frequent = [...cands.values()].filter((c) => c.occ.length >= o.minSupport)

  // Maximality: drop a pattern if a longer one contains it with (almost) the same support.
  frequent.sort((a, b) => b.signature.length - a.signature.length)
  const maximal: Candidate[] = []
  for (const c of frequent) {
    const dominated = maximal.some(
      (m) => m.occ.length >= c.occ.length * 0.8 && isSubsequenceContiguous(c.signature, m.signature),
    )
    if (!dominated) maximal.push(c)
  }

  // Rotations: in a stream "A B C A B C A B C", "B C A" is as frequent as "A B C".
  // Keep the rotation whose first step most often follows a pause, since
  // work items usually begin after one.
  const pauseBefore = (c: Candidate) => {
    let total = 0
    for (const oc of c.occ) {
      const sess = sessions[oc.session]
      total += oc.start === 0 ? o.sessionGapMs : sess[oc.start].ts - sess[oc.start - 1].ts
    }
    return total / c.occ.length
  }
  const rotKey = (sig: string[]) => [...sig].sort().join('>')
  const byRot = new Map<string, Candidate[]>()
  for (const c of maximal) {
    const k = rotKey(c.signature)
    byRot.set(k, [...(byRot.get(k) ?? []), c])
  }
  frequent = [...byRot.values()].map((group) =>
    group.length === 1 ? group[0] : group.reduce((best, c) => (pauseBefore(c) > pauseBefore(best) ? c : best)),
  )

  // Variants: merge similar signatures into the best-supported representative.
  frequent.sort((a, b) => b.occ.length - a.occ.length || b.signature.length - a.signature.length)
  const merged: Candidate[] = []
  for (const c of frequent) {
    const host = merged.find(
      (m) => editDistance(m.signature, c.signature) / Math.max(m.signature.length, c.signature.length) <= o.similarity,
    )
    if (!host) {
      merged.push({ signature: c.signature, occ: [...c.occ] })
      continue
    }
    for (const oc of c.occ) {
      const overlaps = host.occ.some((h) => h.session === oc.session && h.start <= oc.end && oc.start <= h.end)
      if (!overlaps) host.occ.push(oc)
    }
  }

  // Approximate occurrences: a one-off variant (steps reordered, one extra or
  // missing) never reaches minSupport by itself, so look for near-matches of
  // each pattern anchored on the same first and last step.
  for (const c of merged) {
    const L = c.signature.length
    const maxDist = Math.floor(L * o.similarity)
    sessions.forEach((sess, si) => {
      const toks = sess.map((s) => s.token)
      for (let i = 0; i < toks.length; i++) {
        if (toks[i] !== c.signature[0]) continue
        for (let len = Math.max(o.minLength, L - maxDist); len <= L + maxDist && i + len <= toks.length; len++) {
          const end = i + len - 1
          if (toks[end] !== c.signature[L - 1]) continue
          if (c.occ.some((h) => h.session === si && h.start <= end && i <= h.end)) continue
          if (editDistance(toks.slice(i, end + 1), c.signature) <= maxDist) {
            c.occ.push({ session: si, start: i, end })
            break
          }
        }
      }
    })
  }

  return merged
    .map((c) => {
      const occurrences: PatternOccurrence[] = c.occ
        .map((oc) => {
          const sess = sessions[oc.session].slice(oc.start, oc.end + 1)
          return { start: sess[0].ts, end: sess[sess.length - 1].ts, eventIds: sess.flatMap((s) => s.eventIds) }
        })
        .sort((a, b) => a.start - b.start)
      const avgDurationMs = occurrences.reduce((n, x) => n + (x.end - x.start), 0) / occurrences.length
      const apps = [...new Set(c.signature.map(appOf))]
      let transitions = 0
      for (let i = 1; i < c.signature.length; i++) if (appOf(c.signature[i]) !== appOf(c.signature[i - 1])) transitions++
      const score =
        occurrences.length * // frequency
        Math.log2(2 + avgDurationMs / 1000) * // time spent
        (1 + 0.5 * transitions) * // cross-app hand-offs are what automation removes
        Math.sqrt(c.signature.length)
      return { signature: c.signature, occurrences, support: occurrences.length, avgDurationMs, apps, score }
    })
    .sort((a, b) => b.score - a.score)
}
