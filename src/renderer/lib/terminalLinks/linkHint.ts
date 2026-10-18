export interface LinkHint<T> {
  show(measure: () => T | null): void
  hide(): void
}

export function createLinkHint<T>(
  delayMs: number,
  paneVisible: () => boolean,
  publish: (hint: T | null) => void,
): LinkHint<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let shown = false
  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    show(measure) {
      cancel()
      timer = setTimeout(() => {
        timer = null
        if (!paneVisible()) return
        const hint = measure()
        if (!hint) return
        shown = true
        publish(hint)
      }, delayMs)
    },
    hide() {
      cancel()
      if (!shown) return
      shown = false
      publish(null)
    },
  }
}
