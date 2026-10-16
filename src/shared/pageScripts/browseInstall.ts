/// <reference lib="dom" />
import { BROWSE_RUNTIME_GLOBAL } from '../browser/browseRuntime'
import { browseRuntime } from './browsePage'

const page = window as unknown as Record<string, unknown>
page[BROWSE_RUNTIME_GLOBAL] = page[BROWSE_RUNTIME_GLOBAL] || browseRuntime(window)
