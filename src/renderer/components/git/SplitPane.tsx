import {
  type SplitBounds,
  clampPosition,
  fractionOf,
  keyPosition,
  percentOf,
  splitBasis,
  splitBounds,
} from '@/lib/git/gitSplit'
import { rememberPanelFractions, rememberedPanelFraction } from '@/lib/panes/panelSizes'
import { cn } from '@/lib/utils'
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

const DRAGGING_CLASS = 'ostia-split-dragging'

interface Measure {
  collapsed: boolean
  min: number
  max: number
  now: number
}

const UNMEASURED: Measure = { collapsed: false, min: 0, max: 100, now: 0 }

export function splitSizeKey(splitKey: string): string {
  return `git:${splitKey}`
}

export function SplitPane({
  splitKey,
  label,
  first,
  second,
  firstClassName,
  secondClassName,
  defaultFraction,
  minFirst,
  minSecond,
  collapseSecond = false,
}: {
  splitKey: string
  label: string
  first: ReactNode
  second: ReactNode | null
  firstClassName?: string
  secondClassName?: string
  defaultFraction: number
  minFirst: number
  minSecond: number
  collapseSecond?: boolean
}): JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const firstPane = useRef<HTMLDivElement>(null)
  const handle = useRef<HTMLDivElement>(null)
  const [fraction, setFraction] = useState(
    () => rememberedPanelFraction(splitSizeKey(splitKey)) ?? defaultFraction,
  )
  const [measure, setMeasure] = useState<Measure>(UNMEASURED)
  const split = second !== null

  const total = useCallback((): number => {
    const height = container.current?.clientHeight ?? 0
    return Math.max(0, height - (handle.current?.offsetHeight ?? 0))
  }, [])

  const bounds = useCallback(
    (): SplitBounds => splitBounds(total(), minFirst, minSecond),
    [total, minFirst, minSecond],
  )

  const sync = useCallback((): void => {
    const size = total()
    const b = bounds()
    const position = size > 0 ? (firstPane.current?.getBoundingClientRect().height ?? 0) : 0
    const next: Measure = {
      collapsed: collapseSecond && size > 0 && b.collapsed,
      min: percentOf(b.min, size),
      max: percentOf(b.max, size),
      now: percentOf(position, size),
    }
    setMeasure((old) =>
      old.collapsed === next.collapsed &&
      old.min === next.min &&
      old.max === next.max &&
      old.now === next.now
        ? old
        : next,
    )
  }, [total, bounds, collapseSecond])

  useEffect(() => {
    if (!split || !container.current || !firstPane.current) return
    const observer = new ResizeObserver(sync)
    observer.observe(container.current)
    observer.observe(firstPane.current)
    sync()
    return () => observer.disconnect()
  }, [split, sync])

  const remember = (next: number): void => {
    rememberPanelFractions([{ key: splitSizeKey(splitKey), fraction: next }])
  }

  const moveTo = (position: number): number => {
    const next = fractionOf(position, total(), bounds())
    setFraction(next)
    return next
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    if (e.button !== 0 || !firstPane.current) return
    e.preventDefault()
    el.focus({ preventScroll: true })
    el.setPointerCapture(e.pointerId)
    if (!el.hasPointerCapture(e.pointerId)) return
    const startY = e.clientY
    const start = firstPane.current.getBoundingClientRect().height
    let latest: number | null = null
    document.documentElement.classList.add(DRAGGING_CLASS)
    const move = (ev: globalThis.PointerEvent): void => {
      latest = moveTo(start + ev.clientY - startY)
    }
    const end = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('lostpointercapture', end)
      document.documentElement.classList.remove(DRAGGING_CLASS)
      if (latest !== null) remember(latest)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('lostpointercapture', end)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!firstPane.current) return
    const b = bounds()
    const current = clampPosition(firstPane.current.getBoundingClientRect().height, b)
    const next = keyPosition(e.key, current, b)
    if (next === null) return
    e.preventDefault()
    remember(moveTo(next))
  }

  const reset = (): void => {
    setFraction(defaultFraction)
    remember(defaultFraction)
  }

  return (
    <div
      ref={container}
      className="ostia-split"
      data-split={splitKey}
      data-single={split ? undefined : ''}
      data-collapsed={split && measure.collapsed ? '' : undefined}
    >
      <div
        ref={firstPane}
        className={cn('ostia-split-first', firstClassName)}
        style={split ? { flexBasis: splitBasis(fraction, minFirst, minSecond) } : undefined}
      >
        {first}
      </div>
      {split ? (
        <>
          <div
            ref={handle}
            className="ostia-split-handle"
            role="separator"
            tabIndex={0}
            aria-orientation="horizontal"
            aria-label={label}
            aria-valuemin={measure.min}
            aria-valuemax={measure.max}
            aria-valuenow={measure.now}
            hidden={measure.collapsed}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            onDoubleClick={reset}
          />
          <div className={cn('ostia-split-second', secondClassName)}>{second}</div>
        </>
      ) : null}
    </div>
  )
}
