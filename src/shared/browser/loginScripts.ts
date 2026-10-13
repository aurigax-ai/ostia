function loginFields() {
  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
  }
  const password = Array.from(document.querySelectorAll('input[type="password"]')).find(visible) as
    | HTMLInputElement
    | undefined
  if (!password) return { password: null, user: null }
  const scope = password.form ?? document
  const inputs = Array.from(scope.querySelectorAll('input')).filter(visible) as HTMLInputElement[]
  const before = inputs.slice(0, inputs.indexOf(password)).reverse()
  const user =
    before.find((i) => i.autocomplete === 'username' || i.type === 'email') ??
    before.find((i) => ['text', 'email', 'tel', ''].includes(i.type)) ??
    null
  return { password, user }
}

export function fillScript(username: string, password: string): string {
  return `(() => {
    const fields = (${loginFields.toString()})()
    if (!fields.password) return { filled: false }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const put = (el, value) => {
      el.focus()
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    if (fields.user && ${JSON.stringify(username)}) put(fields.user, ${JSON.stringify(username)})
    put(fields.password, ${JSON.stringify(password)})
    return { filled: true, user: Boolean(fields.user) }
  })()`
}

export function readScript(): string {
  return `(() => {
    const fields = (${loginFields.toString()})()
    if (!fields.password || !fields.password.value) return null
    return { username: fields.user ? fields.user.value : '', password: fields.password.value }
  })()`
}
