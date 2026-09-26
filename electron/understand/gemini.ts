import { GoogleGenAI } from '@google/genai'
import { getSecret, getSettings } from '../core/settings'

let client: GoogleGenAI | null = null
let clientKey = ''

export function geminiAvailable(): boolean {
  return !!getSecret('geminiKey')
}

function getClient(): GoogleGenAI {
  const key = getSecret('geminiKey')
  if (!key) throw new Error('Gemini API key not configured')
  if (!client || clientKey !== key) {
    client = new GoogleGenAI({ apiKey: key })
    clientKey = key
  }
  return client
}

/** One structured-output call. The schema is a plain JSON Schema object. */
export async function generateJson<T>(opts: { system: string; prompt: string; schema: object; temperature?: number }): Promise<T> {
  const res = await getClient().models.generateContent({
    model: getSettings().geminiModel,
    contents: opts.prompt,
    config: {
      systemInstruction: opts.system,
      temperature: opts.temperature ?? 0.2,
      responseMimeType: 'application/json',
      responseJsonSchema: opts.schema,
    },
  })
  const text = res.text
  if (!text) throw new Error('Gemini returned an empty response')
  return JSON.parse(text) as T
}

export async function testGemini(): Promise<string> {
  const out = await generateJson<{ ok: boolean }>({
    system: 'Reply with JSON.',
    prompt: 'Return {"ok": true}.',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  })
  return out.ok ? `Connected to ${getSettings().geminiModel}` : 'Unexpected response'
}
