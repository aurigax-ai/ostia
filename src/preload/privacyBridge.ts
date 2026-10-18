import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'

export const privacyBridge: Pick<OstiaBridge, 'privacy'> = {
  privacy: {
    kinds: () => ipcRenderer.invoke('privacy:kinds'),
    redact: (texts) => ipcRenderer.invoke('privacy:redact', texts),
    preview: (text) => ipcRenderer.invoke('privacy:preview', text),
  },
}
