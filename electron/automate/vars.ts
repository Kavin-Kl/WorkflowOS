import type { Condition } from '../shared/types'

export type Vars = Record<string, unknown>

/** Replace {{a.b}} with vars["a.b"]; unknown variables become empty strings. */
export function interpolate(template: string, vars: Vars): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const v = vars[key]
    return v === undefined || v === null ? '' : String(v)
  })
}

export function interpolateParams(params: Record<string, string>, vars: Vars): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, interpolate(v, vars).trim()]))
}

/** Flatten { customer: { id } } style outputs into "customer.id" keys. */
export function withOutputs(vars: Vars, namespace: string, outputs: Record<string, unknown>): Vars {
  const next = { ...vars }
  for (const [k, v] of Object.entries(outputs)) next[`${namespace}.${k}`] = v
  return next
}

function truthy(v: unknown): boolean {
  if (typeof v === 'string') return v !== '' && v !== 'false' && v !== '0'
  return !!v
}

export function evaluate(c: Condition, vars: Vars): boolean {
  const v = vars[c.var]
  switch (c.op) {
    case 'exists':
      return v !== undefined && v !== null && v !== ''
    case 'not_exists':
      return v === undefined || v === null || v === ''
    case 'truthy':
      return truthy(v)
    case 'falsy':
      return !truthy(v)
    case 'equals':
      return String(v ?? '') === String(c.value ?? '')
    case 'not_equals':
      return String(v ?? '') !== String(c.value ?? '')
    case 'contains':
      return String(v ?? '').toLowerCase().includes(String(c.value ?? '').toLowerCase())
  }
}
