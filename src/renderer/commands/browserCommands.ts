import { type BrowserAction, runBrowserAction } from '../lib/browserHandles'
import { type CoreCommandId, registerCore } from './core'

const BROWSER_COMMANDS: readonly [CoreCommandId, BrowserAction][] = [
  ['browser.focusAddress', 'focusAddress'],
  ['browser.reload', 'reload'],
  ['browser.back', 'back'],
  ['browser.forward', 'forward'],
  ['browser.find', 'find'],
]

export function registerBrowserCommands(): void {
  for (const [id, action] of BROWSER_COMMANDS) {
    registerCore<undefined, { handled: boolean }>({
      id,
      category: 'browser',
      capabilities: ['browse'],
      run: (_args, ctx) => ({
        handled: ctx.activePaneId ? runBrowserAction(ctx.activePaneId, action) : false,
      }),
    })
  }
}
