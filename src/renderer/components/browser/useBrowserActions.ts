import type { WebviewTag } from 'electron'
import {
  type Dispatch,
  type KeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
} from 'react'
import {
  type BrowserAction,
  browserActionOf,
  registerBrowserHandle,
} from '@/lib/browser/browserHandles'
import { matchChord } from '@/lib/keyboard/chords'
import { isMac } from '@/platform'
import type { FindRequest, FindResult } from './BrowserFind'

interface BrowserActionsParams {
  paneId: string
  webviewRef: MutableRefObject<HTMLElement | null>
  readyRef: MutableRefObject<boolean>
  addressRef: MutableRefObject<HTMLInputElement | null>
  findStepRef: MutableRefObject<((by: number) => void) | null>
  withGuest: (fn: (wv: WebviewTag) => void) => boolean
  setFindFocus: Dispatch<SetStateAction<number>>
  setFindResult: (result: FindResult | null) => void
}

export function useBrowserActions({
  paneId,
  webviewRef,
  readyRef,
  addressRef,
  findStepRef,
  withGuest,
  setFindFocus,
  setFindResult,
}: BrowserActionsParams) {
  const searchPage = useCallback(
    ({ text, forward, next }: FindRequest): void => {
      withGuest((wv) => {
        wv.findInPage(text, { forward, findNext: !next })
      })
    },
    [withGuest],
  )

  const clearFind = useCallback((): void => {
    withGuest((wv) => wv.stopFindInPage('clearSelection'))
    setFindResult(null)
  }, [withGuest, setFindResult])

  const closeFind = useCallback((): void => {
    clearFind()
    setFindFocus(-1)
    withGuest((wv) => wv.focus())
  }, [clearFind, withGuest, setFindFocus])

  const runAction = useCallback(
    (action: BrowserAction): void => {
      if (action === 'focusAddress') {
        addressRef.current?.focus()
        addressRef.current?.select()
      } else if (action === 'reload') withGuest((wv) => wv.reload())
      else if (action === 'back') withGuest((wv) => wv.canGoBack() && wv.goBack())
      else if (action === 'forward') withGuest((wv) => wv.canGoForward() && wv.goForward())
      else if (action !== 'find' && findStepRef.current) {
        findStepRef.current(action === 'findNext' ? 1 : -1)
      } else setFindFocus((n) => Math.max(n, 0) + 1)
    },
    [withGuest, addressRef, findStepRef, setFindFocus],
  )

  useEffect(
    () =>
      registerBrowserHandle(paneId, {
        guestId: () => {
          const wv = webviewRef.current as unknown as WebviewTag | null
          if (!wv || !readyRef.current) return null
          try {
            return wv.getWebContentsId()
          } catch {
            return null
          }
        },
        focusAddress: () => runAction('focusAddress'),
        reload: () => runAction('reload'),
        back: () => runAction('back'),
        forward: () => runAction('forward'),
        find: () => runAction('find'),
        findNext: () => runAction('findNext'),
        findPrevious: () => runAction('findPrevious'),
      }),
    [paneId, runAction, webviewRef, readyRef],
  )

  const onSurfaceKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const chord = matchChord(e, isMac)
    const action = chord ? browserActionOf(chord) : null
    if (!action) return
    e.preventDefault()
    e.stopPropagation()
    runAction(action)
  }

  return { searchPage, clearFind, closeFind, onSurfaceKeyDown }
}
