import { setTimeout as sleep } from 'node:timers/promises'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { globMatches } from '../../shared/browser/browseInput'
import type { BrowseOutcome, ElementState, FindQuery } from '../../shared/browser/browseRuntime'
import { formatSnapshot, type SnapshotNode } from '../../shared/browser/browseSnapshot'
import type { BrowseInput } from './browseInput'
import {
  type BrowseDeps,
  type BrowseMethod,
  clampTimeout,
  debuggerCommand,
  fail,
  MAX_TIMEOUT_MS,
  num,
  safeOutPath,
  scratchPath,
  str,
  waitFor,
  world,
  writeOut,
} from './browseMethod'
import { jsArgs, runInBrowseWorld } from './browseWorld'
import { networkIdleFor } from './guestNetwork'

const NETWORK_IDLE_MS = 500

async function findAction(
  input: BrowseInput,
  guest: Electron.WebContents,
  ref: string,
  action: string,
  text: string,
): Promise<unknown> {
  const { clickTarget, mouseMove, settle, typeText, setChecked } = input
  switch (action) {
    case 'click':
      return withRef(ref, await clickTarget(guest, ref, 1))
    case 'fill':
      return withRef(ref, await world(guest, `fill(${jsArgs(ref, text)})`))
    case 'type': {
      const focused = await world(guest, `focus(${jsArgs(ref)})`)
      if (!focused.ok) return focused
      typeText(guest, text)
      await settle(guest)
      return { ok: true, ref }
    }
    case 'check':
      return withRef(ref, await setChecked(guest, ref, true))
    case 'uncheck':
      return withRef(ref, await setChecked(guest, ref, false))
    case 'hover': {
      const at = await world<{ x: number; y: number }>(guest, `point(${jsArgs(ref)})`)
      if (!at.ok) return at
      mouseMove(guest, at.x, at.y)
      await settle(guest)
      return { ok: true, ref }
    }
    case 'text': {
      const got = await world<{ value: unknown }>(guest, `get(${jsArgs('text', ref, null)})`)
      return got.ok ? { ok: true, ref, value: got.value } : got
    }
    default:
      return fail('bad-action', action)
  }
}

interface QueryDeps extends Pick<BrowseDeps, 'screenshotRoots'> {
  method: BrowseMethod
  input: BrowseInput
}

export function registerBrowseQueryMethods(deps: QueryDeps): void {
  const { method } = deps

  method('screenshot', async (guest, p, _ctx, rendererPaneId) => {
    const requested = str(p.path)
    const outPath = requested ? safeOutPath(deps, requested) : scratchPath(rendererPaneId, 'png')
    if (!outPath) return fail('path-denied', requested)
    if (p.full === true) {
      const metrics = await debuggerCommand<{ cssContentSize: { width: number; height: number } }>(
        guest,
        'Page.getLayoutMetrics',
      )
      const shot = await debuggerCommand<{ data: string }>(guest, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: Math.ceil(metrics.cssContentSize.width),
          height: Math.ceil(metrics.cssContentSize.height),
          scale: 1,
        },
      })
      writeOut(outPath, Buffer.from(shot.data, 'base64'))
    } else {
      const image = await guest.capturePage()
      writeOut(outPath, image.toPNG())
    }
    return { ok: true, path: outPath }
  })

  method('pdf', async (guest, p) => {
    const requested = str(p.path)
    if (!requested) return fail('path-required')
    const outPath = safeOutPath(deps, requested)
    if (!outPath) return fail('path-denied', requested)
    writeOut(outPath, await guest.printToPDF({}))
    return { ok: true, path: outPath }
  })

  method('snapshot', async (guest, p) => {
    const result = await world<{ tree: SnapshotNode[] }>(
      guest,
      `snapshot(${jsArgs(str(p.selector) ?? null)})`,
    )
    if (!result.ok) return result
    const { snapshot, refs } = formatSnapshot(result.tree, {
      interactive: p.interactive === true,
      compact: p.compact === true,
      depth: num(p.depth),
      urls: p.urls === true,
    })
    return { ok: true, snapshot, refs, url: guest.getURL(), title: guest.getTitle() }
  })

  method('eval', async (guest, p) => {
    const js = str(p.js)
    if (!js) return fail('js-required')
    const result = await guest.executeJavaScript(js, true)
    return { ok: true, result: result === undefined ? null : result }
  })

  method('get', (guest, p) => {
    const sub = str(p.sub) ?? ''
    if (sub === 'cdp-url')
      return fail('unsupported', `${PRODUCT_DISPLAY_NAME} drives its own browser panes`)
    return world(guest, `get(${jsArgs(sub, str(p.target) ?? null, str(p.arg) ?? null)})`)
  })

  method('is', (guest, p) => world(guest, `is(${jsArgs(str(p.sub), str(p.target))})`))

  method('find', async (guest, p) => {
    const query: FindQuery = {
      by: str(p.by) ?? '',
      value: str(p.value) ?? '',
      name: str(p.name),
      exact: p.exact === true,
      index: num(p.index),
    }
    const found = await world<{ ref: string }>(guest, `find(${jsArgs(query)})`)
    if (!found.ok) return found
    const ref = `@${found.ref}`
    const action = str(p.action) ?? 'click'
    const text = str(p.text) ?? ''
    return findAction(deps.input, guest, ref, action, text)
  })

  method('wait', async (guest, p) => {
    const timeoutMs = clampTimeout(p.timeoutMs)
    if (num(p.ms) !== undefined) {
      await sleep(Math.min(num(p.ms) ?? 0, MAX_TIMEOUT_MS))
      return { ok: true }
    }
    let check: () => Promise<boolean>
    const target = str(p.target)
    const text = str(p.text)
    const url = str(p.url)
    const load = str(p.load)
    const fn = str(p.fn)
    if (target) {
      const state = (str(p.state) ?? 'visible') as ElementState
      if (!['visible', 'hidden', 'attached', 'detached'].includes(state)) {
        return fail('bad-state', state)
      }
      check = () => runInBrowseWorld<boolean>(guest, `hasState(${jsArgs(target, state)})`)
    } else if (text !== undefined) {
      check = () => runInBrowseWorld<boolean>(guest, `hasText(${jsArgs(text)})`)
    } else if (url !== undefined) {
      check = async () => globMatches(url, guest.getURL())
    } else if (load !== undefined) {
      if (!['load', 'domcontentloaded', 'networkidle'].includes(load)) {
        return fail('bad-load-state', load)
      }
      check = async () => {
        const ready = await runInBrowseWorld<string>(guest, 'readyState()')
        if (load === 'domcontentloaded') return ready !== 'loading'
        if (ready !== 'complete' || guest.isLoading()) return false
        return load === 'load' || networkIdleFor(guest.id, Date.now(), NETWORK_IDLE_MS)
      }
    } else if (fn !== undefined) {
      check = async () => Boolean(await guest.executeJavaScript(`!!(${fn})`, false))
    } else {
      return fail('condition-required')
    }
    return (await waitFor(check, timeoutMs))
      ? { ok: true }
      : fail('timeout', `condition not met within ${timeoutMs}ms`)
  })
}

function withRef(ref: string, outcome: BrowseOutcome): BrowseOutcome<{ ref?: string }> {
  return outcome.ok ? { ok: true, ref } : outcome
}
