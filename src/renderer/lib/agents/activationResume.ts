import { resumeOnActivation } from './autoResume'

function paneBodyAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  if (target.closest('.pane-header')) return null
  return target.closest<HTMLElement>('.pane[data-pane-id]')?.dataset.paneId ?? null
}

export function startActivationResume(): () => void {
  const onClick = (e: Event): void => {
    if (!e.isTrusted || (e as MouseEvent).button !== 0) return
    const paneId = paneBodyAt(e.target)
    if (paneId) resumeOnActivation(paneId)
  }

  window.addEventListener('click', onClick, true)
  return () => window.removeEventListener('click', onClick, true)
}
