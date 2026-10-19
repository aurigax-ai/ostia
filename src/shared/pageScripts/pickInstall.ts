/// <reference lib="dom" />
import { PICK_RUNTIME_GLOBAL } from '../browser/pickRuntime'
import { pickRuntime } from './pickPage'

const page = window as unknown as Record<string, unknown>
page[PICK_RUNTIME_GLOBAL] = page[PICK_RUNTIME_GLOBAL] || pickRuntime(window)
