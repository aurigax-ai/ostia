/// <reference lib="dom" />
import type { PickBox, PickTheme, RawPick } from './pick'

export interface PickSelection {
  url: string
  title: string
  text: string
  box: PickBox
  viewport: { width: number; height: number }
}

export interface PickRuntime {
  selectorFor: (el: Element) => string
  labelFor: (el: Element) => string
  roleOf: (el: Element) => string
  nameOf: (el: Element) => string
  describe: (el: Element) => RawPick
  start: (theme: PickTheme) => Promise<RawPick | null>
  cancel: () => void
  active: () => boolean
  selection: () => PickSelection | null
}

export const PICK_RUNTIME_GLOBAL = '__ostiaPick'
