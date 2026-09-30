export function loginFillRuntime(username: string, password: string): boolean {
  const visible = (el: HTMLInputElement): boolean => {
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && !el.disabled
  }
  const passwordField = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
  ).find(visible)
  if (!passwordField) return false
  const fields = Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter(visible)
  const index = fields.indexOf(passwordField)
  const userField = fields
    .slice(0, index)
    .reverse()
    .find((el) => ['text', 'email', 'tel', ''].includes(el.type) || el.autocomplete === 'username')
  const set = (el: HTMLInputElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (userField && username) set(userField, username)
  set(passwordField, password)
  return true
}
