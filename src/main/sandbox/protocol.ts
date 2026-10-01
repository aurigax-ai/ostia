import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { PackageRef } from '../../shared/packages'
import type { PackageBlockReason, PackagePolicy } from './packagePolicy'

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

export type HostToMain = HostResponse | HostAsk | HostPackageBlocked | HostViolations

export type MainToHost = HostRequest | HostAskAnswer
