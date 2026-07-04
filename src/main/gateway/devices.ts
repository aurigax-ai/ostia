/**
 * Paired-device store for the LAN control gateway (Phase C batch 1,
 * `pine-companion/NETWORK-CONTRACT.md` §3, §4). A `jsonStore` JSON file, **global** scope
 * (`gateway-devices` — machine-wide: pairing a phone isn't scoped to any one project), keyed
 * by `deviceId`, holding the phone's pubkey + a bearer `deviceToken` plus its granted
 * capability subset.
 *
 * `caps` here are **phone-facing** capability strings from the contract (§5: `read`,
 * `board.read`, `notify`, `command`, `input`, `board.write`, `destructive`) — a different,
 * smaller vocabulary than the internal `Capability` union in `shared/capabilities.ts`. The
 * gateway is an ADAPTER (contract §0.1): it translates between the two, so these are kept as
 * plain strings rather than reusing `Capability`.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { loadJson, saveJson, storePath } from '../jsonStore'

/** Phone's initial capability subset on pairing (contract §4 step 4) — read-only by default. */
export const DEFAULT_PHONE_CAPS: readonly string[] = ['read', 'board.read', 'notify']

export interface Device {
  deviceId: string
  name: string
  pubkey: string
  token: string
  caps: string[]
  createdAt: string
}

/** deviceId -> Device */
type DeviceStore = Record<string, Device>

function storeFile(): string {
  return storePath('gateway-devices', 'global')
}

function load(): DeviceStore {
  return loadJson<DeviceStore>(storeFile(), {})
}

/** `secure: true` — this store holds bearer tokens (contract §3/§4), so the file lands `0600`
 *  and its directory `0700` (security review finding: other local users must not be able to
 *  read a paired phone's token off disk). */
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

/** Register a newly-paired device: mints a `deviceId` + opaque bearer token, seeds default caps. */
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

/**
 * Constant-time string compare — a plain `===` on bearer tokens leaks timing information (an
 * attacker can measure response latency to learn how many leading bytes matched, letting a
 * brute-force guesser recover a valid token byte-by-byte instead of needing the whole 64-char
 * value at once). `timingSafeEqual` requires equal-length buffers, so the length check runs
 * first — mismatched lengths are a safe (length isn't secret-dependent per-guess) fast rejection
 * rather than a byte-by-byte compare.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** Look up a device by its bearer token (the WS `hello` handshake) — null if unknown/revoked.
 *  Every candidate is compared in constant time (see `timingSafeStringEqual`) — this loop
 *  intentionally never short-circuits into a length-then-content-shaped side channel. */
export function verifyToken(token: string): Device | null {
  let found: Device | null = null
  for (const device of Object.values(load())) {
    if (timingSafeStringEqual(device.token, token)) found = device
  }
  return found
}

/** Every paired device — callers MUST strip `token` before handing this to a phone-facing method. */
export function list(): Device[] {
  return Object.values(load())
}

/** Look up a device by id — null if unknown/revoked. Used by the gateway's live re-check on
 *  every authed request/frame (not just at `hello` time): "revocation must kill live sessions"
 *  means an already-authed socket must stop working the instant its device is gone, so
 *  `server.ts` calls this on every subsequent message rather than trusting the `hello`-time
 *  auth forever. */
export function get(deviceId: string): Device | null {
  const store = load()
  return Object.hasOwn(store, deviceId) ? store[deviceId] : null
}

/** Revoke (delete) a paired device. Immediate: its token stops verifying on the very next call. */
export function revoke(deviceId: string): boolean {
  const store = load()
  if (!Object.hasOwn(store, deviceId)) return false
  delete store[deviceId]
  save(store)
  return true
}
