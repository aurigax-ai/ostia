const MESSAGE_MAX = 300

export function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MESSAGE_MAX) : ''
}

export function firstQuestion(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const questions = (input as { questions?: unknown }).questions
  if (!Array.isArray(questions)) return ''
  const first: unknown = questions[0]
  return typeof first === 'object' && first !== null
    ? text((first as { question?: unknown }).question)
    : ''
}
