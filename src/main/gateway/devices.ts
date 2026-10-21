import { randomBytes, randomUUID } from 'node:crypto'
import { cleanDeviceName } from '../../shared/gateway/deviceName'
import type { GatewaySetCapResult } from '../../shared/gateway/gatewayApi'
import {
  PHONE_BASE_CAPS,
  PHONE_GRANTABLE_CAPS,
  type PhoneCap,
  type PhoneGrantableCap,
} from '../../shared/gateway/phoneCapabilities'
import { loadJson, saveJson, storePath } from '../platform/jsonStore'
import { sameBytes } from '../platform/sameBytes'

export const DEFAULT_PHONE_CAPS: readonly string[] = PHONE_BASE_CAPS

const CAP_ORDER: readonly PhoneCap[] = [...PHONE_BASE_CAPS, ...PHONE_GRANTABLE_CAPS]

export interface Device {
  deviceId: string
  name: string
  pubkey: string
  token: string
  caps: string[]
  createdAt: string
  lastSeenAt?: string
  installId?: string
}

type DeviceStore = Record<string, Device>

function storeFile(): string {
  return storePath('gateway-devices', 'global')
}

function knownCaps(caps: unknown): string[] {
  const held = Array.isArray(caps) ? caps : []
  return CAP_ORDER.filter((cap) => held.includes(cap))
}

function load(): DeviceStore {
  const store = loadJson<DeviceStore>(storeFile(), {})
  for (const device of Object.values(store)) device.caps = knownCaps(device.caps)
  return store
}

function save(store: DeviceStore): void {
  saveJson(storeFile(), store, { secure: true })
}

export interface RegisterDeviceInput {
  name: string
  pubkey: string
  installId?: string
}

export interface RegisteredDevice {
  deviceId: string
  token: string
  caps: string[]
  replaced: string[]
}

export function registerDevice(input: RegisterDeviceInput): RegisteredDevice {
  const store = load()
  const replaced = input.installId
    ? Object.values(store).filter((d) => d.installId === input.installId)
    : []
  for (const old of replaced) delete store[old.deviceId]
  const device: Device = {
    deviceId: `dev_${randomUUID()}`,
    name: cleanDeviceName(input.name) ?? 'Phone',
    pubkey: input.pubkey,
    token: randomBytes(32).toString('hex'),
    caps: replaced[0] ? [...replaced[0].caps] : [...DEFAULT_PHONE_CAPS],
    createdAt: new Date().toISOString(),
    ...(input.installId ? { installId: input.installId } : {}),
  }
  store[device.deviceId] = device
  save(store)
  return {
    deviceId: device.deviceId,
    token: device.token,
    caps: device.caps,
    replaced: replaced.map((d) => d.deviceId),
  }
}

export function deviceByInstallId(installId: string | undefined): Device | null {
  if (!installId) return null
  return list().find((d) => d.installId === installId) ?? null
}

export function touchDevice(deviceId: string): void {
  const store = load()
  if (!Object.hasOwn(store, deviceId)) return
  store[deviceId].lastSeenAt = new Date().toISOString()
  save(store)
}

export function setDeviceName(deviceId: string, name: unknown): boolean {
  const clean = cleanDeviceName(name)
  const store = load()
  if (!clean || !Object.hasOwn(store, deviceId)) return false
  if (store[deviceId].name === clean) return true
  store[deviceId].name = clean
  save(store)
  return true
}

export function verifyToken(token: string): Device | null {
  let found: Device | null = null
  for (const device of Object.values(load())) {
    if (sameBytes(Buffer.from(device.token), Buffer.from(token))) found = device
  }
  return found
}

export function list(): Device[] {
  return Object.values(load())
}

export function get(deviceId: string): Device | null {
  const store = load()
  return Object.hasOwn(store, deviceId) ? store[deviceId] : null
}

export function revoke(deviceId: string): boolean {
  const store = load()
  if (!Object.hasOwn(store, deviceId)) return false
  delete store[deviceId]
  save(store)
  return true
}

function isGrantableCap(cap: unknown): cap is PhoneGrantableCap {
  return typeof cap === 'string' && (PHONE_GRANTABLE_CAPS as readonly string[]).includes(cap)
}

export function setDeviceCap(
  deviceId: string,
  cap: unknown,
  granted: boolean,
): GatewaySetCapResult {
  if (!isGrantableCap(cap)) return { ok: false, error: 'invalid-cap' }
  const store = load()
  if (!Object.hasOwn(store, deviceId)) return { ok: false, error: 'not-found' }
  const device = store[deviceId]
  const next = new Set(device.caps)
  if (granted) {
    if (cap === 'destructive' && !next.has('command')) {
      return { ok: false, error: 'requires-command' }
    }
    next.add(cap)
  } else {
    next.delete(cap)
    if (cap === 'command') next.delete('destructive')
  }
  device.caps = CAP_ORDER.filter((c) => next.has(c))
  save(store)
  return { ok: true, caps: device.caps }
}
