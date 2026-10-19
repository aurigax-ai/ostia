export interface RenderGate<V> {
  begin: () => number
  mayPaint: (render: number, startedFor: V, current: V) => boolean
}

export function renderGate<V>(): RenderGate<V> {
  let started = 0
  let painted = 0
  return {
    begin: () => ++started,
    mayPaint: (render, startedFor, current) => {
      if (startedFor !== current || render < painted) return false
      painted = render
      return true
    },
  }
}
