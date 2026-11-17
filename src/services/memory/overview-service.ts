import { OVERVIEW_PROMPT, CORRECTION_PROMPT } from './overview-prompts.js'
import { request, API_ORIGIN } from '../api/client.js'
import { useSettings } from '../settings.js'
import { initMemory, storeMemoryOverview, useMemoryState } from './engine.js'
import { memorySnapshot, parseMemoryCorrection, parseOverview } from './overview-model.js'
import { looksLikeSecret } from './policy.js'

const runOverviewModel = async (
  prompt: string,
  payload: unknown,
  snapshot: string,
  signal: AbortSignal
) => {
  const settings = useSettings.getState()
  if (!settings.apiKey || !settings.memoryEnabled) {
    throw new Error('memoryOverviewEnable')
  }
  if (JSON.stringify(payload).length > 24_000) {
    throw new Error('memoryOverviewTooLarge')
  }
  const apiKey = settings.apiKey
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal.aborted) {
    abort()
  }
  signal.addEventListener('abort', abort, { once: true })
  const offMemory = useMemoryState.subscribe((state) => {
    if (memorySnapshot(state.saved) !== snapshot) {
      abort()
    }
  })
  const offSettings = useSettings.subscribe((state) => {
    if (state.apiKey !== apiKey || !state.memoryEnabled) {
      abort()
    }
  })
  const timer = setTimeout(abort, 30_000)
  try {
    const response = await request(`${API_ORIGIN}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        thinking: { type: 'disabled' },
        max_tokens: 4000,
        safety_check: { level: 'high' },
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }),
    })
    const body = (await response.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[]
    }
    if (controller.signal.aborted || memorySnapshot(useMemoryState.getState().saved) !== snapshot) {
      throw new Error('memoryOverviewChanged')
    }
    if (
      body.choices?.[0]?.finish_reason !== 'stop' ||
      typeof body.choices[0].message?.content !== 'string'
    ) {
      throw new Error('memoryOverviewInvalid')
    }
    return body.choices[0].message.content
  } finally {
    clearTimeout(timer)
    offMemory()
    offSettings()
    signal.removeEventListener('abort', abort)
  }
}

export const generateMemoryOverview = async (signal: AbortSignal) => {
  await initMemory()
  const saved = useMemoryState.getState().saved
  const active = saved.filter((memory) => !memory.muted)
  if (!active.length) {
    return
  }
  const snapshot = memorySnapshot(saved)
  const content = await runOverviewModel(
    OVERVIEW_PROMPT,
    {
      locale: useSettings.getState().locale,
      memories: active.map(({ id, text, updatedAt }) => ({ id, text, updatedAt })),
    },
    snapshot,
    signal
  )
  await storeMemoryOverview(parseOverview(content, saved), snapshot)
}

export const proposeMemoryCorrection = async (
  instruction: string,
  scope: string[] | undefined,
  selection: string | undefined,
  signal: AbortSignal
) => {
  await initMemory()
  if (!instruction.trim() || instruction.length > 2000 || looksLikeSecret(instruction)) {
    throw new Error('memoryInvalidContent')
  }
  const all = useMemoryState.getState().saved
  const saved = all.filter((memory) => !memory.muted && (!scope || scope.includes(memory.id)))
  const snapshot = memorySnapshot(all)
  const content = await runOverviewModel(
    CORRECTION_PROMPT,
    {
      instruction,
      selection,
      memories: saved.map(({ id, text, updatedAt }) => ({ id, text, updatedAt })),
    },
    snapshot,
    signal
  )
  return parseMemoryCorrection(content, saved, snapshot)
}
