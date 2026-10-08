import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { PackageRef } from '../../shared/packages'
import type { PackageBlockReason, PackagePolicy } from './packagePolicy'

export const HOST_PROTOCOL_VERSION = 1

export type HostRequest =
  | { id: number; type: 'init'; config: SandboxRuntimeConfig; packages?: PackagePolicy }
  | {
      id: number
      type: 'wrap'
      command: string
      binShell: string
      customConfig?: Partial<SandboxRuntimeConfig>
    }
  | { id: number; type: 'update'; config: SandboxRuntimeConfig; packages?: PackagePolicy }
  | { id: number; type: 'cleanup' }
  | { id: number; type: 'shutdown' }

export type HostResponse =
  | { id: number; ok: true; wrapped?: string }
  | { id: number; ok: false; error: string; missing?: string[] }

export type HostAsk = { type: 'ask'; askId: number; host: string; port?: number }

export type HostAskAnswer = { type: 'ask-answer'; askId: number; allow: boolean }

export type HostPackageBlocked = {
  type: 'package-blocked'
  pkg: PackageRef
  reason: PackageBlockReason
}

export type HostViolations = { type: 'violations'; lines: string[] }

export type HostHello = { type: 'hello'; protocol: number }

export type HostToMain = HostResponse | HostAsk | HostPackageBlocked | HostViolations | HostHello

export type MainToHost = HostRequest | HostAskAnswer
