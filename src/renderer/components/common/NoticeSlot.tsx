import {
  isValidElement,
  type JSX,
  type ReactElement,
  type ReactNode,
  useEffect,
  useReducer,
  useRef,
} from 'react'

const EXIT_ANIMATION = /-out$/

export function NoticeSlot({ children }: { children: ReactNode }): JSX.Element | null {
  const node = isValidElement(children) ? children : null
  const last = useRef<ReactElement | null>(null)
  const slotRef = useRef<HTMLDivElement>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  if (node) last.current = node
  const shown = node ?? last.current
  const leaving = node === null && shown !== null

  useEffect(() => {
    const slot = slotRef.current
    if (slot) slot.inert = leaving
    if (!leaving || !slot) return
    const done = (): void => {
      last.current = null
      redraw()
    }
    slot.addEventListener('animationcancel', done)
    return () => slot.removeEventListener('animationcancel', done)
  }, [leaving])

  if (!shown) return null
  return (
    <div
      ref={slotRef}
      className="notice-slot"
      data-leaving={leaving || undefined}
      aria-hidden={leaving || undefined}
      onAnimationEnd={
        leaving
          ? (e) => {
              if (!EXIT_ANIMATION.test(e.animationName)) return
              last.current = null
              redraw()
            }
          : undefined
      }
    >
      {shown}
    </div>
  )
}
