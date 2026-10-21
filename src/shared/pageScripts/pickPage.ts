/// <reference lib="dom" />
import type { PickRuntime } from '../browser/pickRuntime'
import { createDescribe } from './pickDescribe'
import { createPickSession } from './pickOverlay'
import { createSelectionReader } from './pickSelection'
import { createSelectors } from './pickSelectors'

export function pickRuntime(win: Window & typeof globalThis): PickRuntime {
  const { selectorFor } = createSelectors(win)
  const { roleOf, nameOf, labelFor, describe, resolve } = createDescribe({ win, selectorFor })
  const { start, cancel, active } = createPickSession({
    win,
    labelFor,
    describe,
    resolveTarget: resolve,
  })
  const { selection } = createSelectionReader(win)

  return {
    selectorFor,
    labelFor,
    roleOf,
    nameOf,
    describe,
    start,
    cancel,
    active,
    selection,
  }
}
