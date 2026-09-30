export const LINK_MODIFIER_CLASS = 'link-modifier'

export function linkModifierHeld(e: { ctrlKey: boolean; metaKey: boolean }, mac: boolean): boolean {
  return mac ? e.metaKey : e.ctrlKey
}

export function attachLinkModifier(host: HTMLElement, mac: boolean): () => void {
  const sync = (e: KeyboardEvent | MouseEvent): void => {
    host.classList.toggle(LINK_MODIFIER_CLASS, linkModifierHeld(e, mac))
  }
  const clear = (): void => host.classList.remove(LINK_MODIFIER_CLASS)
  window.addEventListener('keydown', sync, true)
  window.addEventListener('keyup', sync, true)
  host.addEventListener('mousemove', sync)
  window.addEventListener('blur', clear)
  return () => {
    clear()
    window.removeEventListener('keydown', sync, true)
    window.removeEventListener('keyup', sync, true)
    host.removeEventListener('mousemove', sync)
    window.removeEventListener('blur', clear)
  }
}
