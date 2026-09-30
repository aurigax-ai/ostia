import { BROWSE_RUNTIME_GLOBAL, browseRuntimeScript } from '../shared/browseRuntime'

export const BROWSE_WORLD_ID = 1025

const RUNTIME_SCRIPT = browseRuntimeScript()

export function runInBrowseWorld<T>(guest: Electron.WebContents, expression: string): Promise<T> {
  return guest.executeJavaScriptInIsolatedWorld(BROWSE_WORLD_ID, [
    { code: `${RUNTIME_SCRIPT}\nwindow.${BROWSE_RUNTIME_GLOBAL}.${expression}` },
  ]) as Promise<T>
}

export function jsArgs(...values: unknown[]): string {
  return values.map((v) => JSON.stringify(v === undefined ? null : v)).join(', ')
}
