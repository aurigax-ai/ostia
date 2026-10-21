export interface FrameCoalesced {
  (): void
  cancel: () => void
}

export function frameCoalesce(fn: () => void): FrameCoalesced {
  let frame = 0
  const run = (() => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      fn()
    })
  }) as FrameCoalesced
  run.cancel = () => {
    if (!frame) return
    cancelAnimationFrame(frame)
    frame = 0
  }
  return run
}
