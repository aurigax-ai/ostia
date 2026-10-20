import { h, panelTranslator } from '@aurigax-ai/ostia-extension-sdk/panel'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'

export const t = panelTranslator({ en: en.messages, 'zh-Hant': zhHant.messages })

export function tail(key: string): string {
  const parts = key.split('/')
  return parts[parts.length - 1] || key
}

export function button(label: string, onClick: () => void, primary = false): HTMLElement {
  return h('button', { type: 'button', class: primary ? 'primary' : '', onClick }, label)
}

export function field(label: string, control: Node): HTMLElement {
  return h('div', { class: 'field' }, h('span', { class: 'label' }, label), control)
}

export function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function longDate(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}
