import type { ScriptTokensState, ScriptTokenUsage } from '@shared/permissions/scriptTokens'
import { useCallback, useEffect, useState } from 'react'

const EMPTY: ScriptTokensState = { tokens: [], workspaces: [], groups: [] }

const USAGE_REFRESH_MS = 10_000

export function useScriptTokens(): {
  state: ScriptTokensState
  now: number
  reload: () => void
} {
  const [state, setState] = useState<ScriptTokensState>(EMPTY)
  const [now, setNow] = useState(() => Date.now())
  const reload = useCallback(() => {
    void window.ostia.scriptTokens.list().then((next) => {
      setState(next)
      setNow(Date.now())
    })
  }, [])
  useEffect(() => {
    reload()
    return window.ostia.scriptTokens.onChanged(reload)
  }, [reload])
  return { state, now, reload }
}

export function useTokenUsage(detailId: string | null): ScriptTokenUsage | null {
  const [usage, setUsage] = useState<ScriptTokenUsage | null>(null)
  useEffect(() => {
    setUsage(null)
    if (!detailId) return
    let live = true
    const load = (): void => {
      void window.ostia.scriptTokens.usage(detailId).then((next) => {
        if (live) setUsage(next)
      })
    }
    load()
    const timer = window.setInterval(load, USAGE_REFRESH_MS)
    const off = window.ostia.scriptTokens.onChanged(load)
    return () => {
      live = false
      window.clearInterval(timer)
      off()
    }
  }, [detailId])
  return usage
}
