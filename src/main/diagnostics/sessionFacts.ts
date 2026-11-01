import type { BrowserWindow } from 'electron'
import { bucketCount } from '../../shared/privacy/telemetry'
import type { SessionFacts } from './telemetryUsage'

interface SessionFactsDeps {
  readSettings: () => unknown
  installedExtensions: () => string[]
  extensions: () => { id: string; enabled: boolean }[]
  windows: Map<string, BrowserWindow>
  workspacesOf: (win: BrowserWindow) => number
  restoreOutcome: () => SessionFacts['restore']
}

export function createSessionFacts({
  readSettings,
  installedExtensions,
  extensions,
  windows,
  workspacesOf,
  restoreOutcome,
}: SessionFactsDeps): () => SessionFacts {
  return function telemetrySessionFacts(): SessionFacts {
    const settings = readSettings() as {
      behavior?: { inputMode?: unknown; gpuAcceleration?: unknown }
      terminal?: { renderer?: unknown; prompt?: { style?: unknown } }
    }
    const text = (value: unknown, fallback: string): string =>
      typeof value === 'string' ? value : fallback
    const installed = installedExtensions()
    const enabled = extensions()
      .filter((ext) => ext.enabled && installed.includes(ext.id))
      .map((ext) => ext.id)
    let workspaces = 0
    for (const win of windows.values()) {
      if (!win.isDestroyed()) workspaces += workspacesOf(win)
    }
    return {
      windows: bucketCount(windows.size),
      workspaces: bucketCount(workspaces),
      restore: restoreOutcome(),
      inEffect: {
        features: {
          input_mode: text(settings.behavior?.inputMode, 'terminal'),
          prompt_style: text(settings.terminal?.prompt?.style, 'shell'),
        },
        terminal: {
          gpu: settings.behavior?.gpuAcceleration === false ? 'off' : 'on',
        },
      },
      installedExtensions: installed,
      enabledExtensions: enabled,
    }
  }
}
