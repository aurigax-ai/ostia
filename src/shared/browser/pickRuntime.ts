/// <reference lib="dom" />
import type { PickTheme, RawPick } from './pick'

export interface PickRuntime {
  selectorFor: (el: Element) => string
  labelFor: (el: Element) => string
  roleOf: (el: Element) => string
  nameOf: (el: Element) => string
  describe: (el: Element) => RawPick
  start: (theme: PickTheme) => Promise<RawPick | null>
  cancel: () => void
  active: () => boolean
}

export const PICK_RUNTIME_GLOBAL = '__ostiaPick'
