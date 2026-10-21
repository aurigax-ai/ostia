import { contextBridge, ipcRenderer } from 'electron'
import type { OstiaBridge, Platform } from '../shared/types'
import { agentSessionsBridge } from './agentSessionsBridge'
import { agentsBridge } from './agentsBridge'
import { artifactsBridge } from './artifactsBridge'
import { assistBridge } from './assistBridge'
import { attentionBridge } from './attentionBridge'
import { boardsBridge } from './boardsBridge'
import { browserBridge } from './browserBridge'
import { controlBridge } from './controlBridge'
import { diagnosticsBridge } from './diagnosticsBridge'
import { extensionsBridge } from './extensionsBridge'
import { filesBridge } from './filesBridge'
import { gatewayBridge } from './gatewayBridge'
import { lspBridge } from './lspBridge'
import { permissionsBridge } from './permissionsBridge'
import { privacyBridge } from './privacyBridge'
import { sandboxBridge } from './sandboxBridge'
import { serverBridge } from './serverBridge'
import { settingsBridge } from './settingsBridge'
import { syncServerBridge } from './syncServerBridge'
import { systemBridge } from './systemBridge'
import { terminalBridge } from './terminalBridge'
import { updatesBridge } from './updatesBridge'
import { windowBridge } from './windowBridge'
import { workspaceBridge } from './workspaceBridge'

const bridge: OstiaBridge = {
  ping: () => ipcRenderer.invoke('app:ping'),
  info: () => ipcRenderer.invoke('app:info'),
  platform: process.platform as Platform,
  ...windowBridge,
  ...controlBridge,
  ...diagnosticsBridge,
  ...privacyBridge,
  ...terminalBridge,
  ...agentsBridge,
  ...filesBridge,
  ...lspBridge,
  ...workspaceBridge,
  ...artifactsBridge,
  ...browserBridge,
  ...sandboxBridge,
  ...permissionsBridge,
  ...extensionsBridge,
  ...assistBridge,
  ...agentSessionsBridge,
  ...settingsBridge,
  ...updatesBridge,
  ...systemBridge,
  ...gatewayBridge,
  ...serverBridge,
  ...syncServerBridge,
  ...attentionBridge,
  ...boardsBridge,
}

contextBridge.exposeInMainWorld('ostia', bridge)
