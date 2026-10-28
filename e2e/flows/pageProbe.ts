export interface Condition {
  sel: string
  text?: string
  min?: number
  focus?: boolean
  shown?: boolean
}

export interface StartEvent {
  type: 'keydown' | 'click' | 'mousedown'
  key?: string
  sel?: string
}

interface FlowApi {
  begin: (start: StartEvent | null, ends: Record<string, Condition[]>) => string[]
  read: () => Record<string, number>
  reset: () => void
}

export type FlowWindow = Window & { __flow?: FlowApi }

export function flowProbe(): void {
  const w = window as FlowWindow
  if (w.__flow) return
  let marks: Record<string, number> = {}
  let pending: Record<string, Condition[]> = {}
  let stopStart: (() => void) | null = null
  const epoch = (t: number) => performance.timeOrigin + t
  const holds = (c: Condition): boolean => {
    let found = [...document.querySelectorAll(c.sel)]
    if (c.shown) found = found.filter((el) => !el.closest('[data-hidden]'))
    if (c.focus) found = found.filter((el) => el === document.activeElement)
    if (c.text) {
      const pattern = new RegExp(c.text)
      found = found.filter((el) => pattern.test(el.textContent ?? ''))
    }
    return found.length >= (c.min ?? 1)
  }
  const check = () => {
    for (const [name, all] of Object.entries(pending)) {
      if (!all.every(holds)) continue
      delete pending[name]
      requestAnimationFrame((t) => {
        marks[name] = epoch(t)
      })
    }
  }
  new MutationObserver(check).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  })
  document.addEventListener('focusin', check, true)
  w.__flow = {
    begin: (start, ends) => {
      w.__flow?.reset()
      const already = Object.entries(ends)
        .filter(([, all]) => all.every(holds))
        .map(([name]) => name)
      if (start) {
        const listener = (e: Event) => {
          const target = e.target instanceof Element ? e.target : null
          if (start.key && (e as KeyboardEvent).key?.toLowerCase() !== start.key) return
          if (start.sel && !target?.closest(start.sel)) return
          if (marks.start === undefined) marks.start = epoch(e.timeStamp)
        }
        document.addEventListener(start.type, listener, true)
        stopStart = () => document.removeEventListener(start.type, listener, true)
      }
      pending = { ...ends }
      return already
    },
    read: () => ({ ...marks }),
    reset: () => {
      stopStart?.()
      stopStart = null
      marks = {}
      pending = {}
    },
  }
}
