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
        if (hint) publish(hint)
      }, delayMs)
    },
    hide() {
      cancel()
      publish(null)
    },
  }
}
