/// <reference lib="dom" />
import type { PickRuntime } from '../browser/pickRuntime'
import { createDescribe } from './pickDescribe'
import { createPickSession } from './pickOverlay'
import { createSelectors } from './pickSelectors'

export function pickRuntime(win: Window & typeof globalThis): PickRuntime {
  const { selectorFor } = createSelectors(win)
  const { roleOf, nameOf, labelFor, describe } = createDescribe({ win, selectorFor })
  const { start, cancel, active } = createPickSession({ win, labelFor, describe })

  return {
    selectorFor,
    labelFor,
    roleOf,
    nameOf,
    describe,
    start,
    cancel,
    active,
  }
}
