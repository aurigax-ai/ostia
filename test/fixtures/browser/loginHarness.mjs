import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const input = JSON.parse(readFileSync(0, 'utf8'))

class HTMLInputElement {
  constructor(spec) {
    this.type = spec.type ?? 'text'
    this.autocomplete = spec.autocomplete ?? ''
    this.rawValue = spec.value ?? ''
    this.visibleBox = spec.visible !== false
    this.hiddenStyle = spec.hidden === true
    this.formId = spec.form ?? null
    this.form = null
    this.events = []
    this.focused = false
  }
  get value() {
    return this.rawValue
  }
  set value(next) {
    this.rawValue = next
  }
  focus() {
    this.focused = true
  }
  dispatchEvent(event) {
    this.events.push(event.type)
  }
  getBoundingClientRect() {
    return { width: this.visibleBox ? 10 : 0, height: this.visibleBox ? 10 : 0 }
  }
}

class Event {
  constructor(type) {
    this.type = type
  }
}

const inputs = input.inputs.map((spec) => new HTMLInputElement(spec))
const forms = new Map()
for (const element of inputs) {
  if (element.formId === null) continue
  if (!forms.has(element.formId)) {
    forms.set(element.formId, {
      members: [],
      querySelectorAll(selector) {
        return selector === 'input' ? this.members : []
      },
    })
  }
  const form = forms.get(element.formId)
  form.members.push(element)
  element.form = form
}
const document = {
  querySelectorAll(selector) {
    if (selector === 'input[type="password"]') return inputs.filter((el) => el.type === 'password')
    if (selector === 'input') return inputs
    return []
  },
}
const sandbox = {
  document,
  HTMLInputElement,
  Event,
  getComputedStyle: (el) => ({ visibility: el.hiddenStyle ? 'hidden' : 'visible' }),
}
const result = runInNewContext(input.script, sandbox)
process.stdout.write(
  JSON.stringify({
    result: result === undefined ? null : result,
    inputs: inputs.map((el) => ({ value: el.rawValue, events: el.events, focused: el.focused })),
  }),
)
