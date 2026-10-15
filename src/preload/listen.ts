import { type IpcRendererEvent, ipcRenderer } from 'electron'

export function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_event: IpcRendererEvent, ...args: A): void => cb(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
