import { resumeOnActivation } from './autoResume'

function paneBodyAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  if (target.closest('.pane-header')) return null
  return target.closest<HTMLElement>('.pane[data-pane-id]')?.dataset.paneId ?? null
}

export function startActivationResume(): () => void {
  const onPointerDown = (e: Event): void => {
    if (!e.isTrusted || (e as PointerEvent).button !== 0) return
    const paneId = paneBodyAt(e.target)
    if (paneId) resumeOnActivation(paneId)
  }

  window.addEventListener('pointerdown', onPointerDown, true)
  return () => window.removeEventListener('pointerdown', onPointerDown, true)
}
