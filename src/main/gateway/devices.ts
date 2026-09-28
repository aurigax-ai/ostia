import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { loadJson, saveJson, storePath } from '../jsonStore'

export const DEFAULT_PHONE_CAPS: readonly string[] = ['read', 'board.read', 'notify']

export interface Device {
  deviceId: string
  name: string
  pubkey: string
  token: string
  caps: string[]
  createdAt: string
}

type DeviceStore = Record<string, Device>

function storeFile(): string {
  return storePath('gateway-devices', 'global')
}

function load(): DeviceStore {
  return loadJson<DeviceStore>(storeFile(), {})
}

function save(store: DeviceStore): void {
  saveJson(storeFile(), store, { secure: true })
}

export interface RegisterDeviceInput {
  name: string
  pubkey: string
}

export interface RegisteredDevice {
  deviceId: string
  token: string
  caps: string[]
}

export function registerDevice(input: RegisterDeviceInput): RegisteredDevice {
  const store = load()
  const device: Device = {
    deviceId: `dev_${randomUUID()}`,
    name: input.name,
    pubkey: input.pubkey,
    token: randomBytes(32).toString('hex'),
    caps: [...DEFAULT_PHONE_CAPS],
    createdAt: new Date().toISOString(),
  }
  store[device.deviceId] = device
  save(store)
  return { deviceId: device.deviceId, token: device.token, caps: device.caps }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function verifyToken(token: string): Device | null {
  let found: Device | null = null
  for (const device of Object.values(load())) {
    if (timingSafeStringEqual(device.token, token)) found = device
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
