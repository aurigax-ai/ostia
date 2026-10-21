export async function readBoundedBody(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > max) return null
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const body = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}
