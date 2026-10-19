import { type IpcRendererEvent, ipcRenderer } from 'electron'

export function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_event: IpcRendererEvent, ...args: A): void => cb(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

export function answer<Q, R>(
  channel: string,
  replyChannel: string,
  cb: (req: Q) => R | Promise<R>,
): () => void {
  return listen<[number | string, Q]>(
    channel,
    (id, req) =>
      void Promise.resolve(cb(req)).then((result) => ipcRenderer.send(replyChannel, id, result)),
  )
}
