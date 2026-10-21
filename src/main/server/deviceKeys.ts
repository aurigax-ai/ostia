import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from 'node:crypto'

const SEED_BYTES = 32
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const REGISTER_CONTEXT = 'ostia-server/register/v1'
const CHALLENGE_CONTEXT = 'ostia-server/auth/v1'

export interface DeviceKeys {
  signPrivate: KeyObject
  boxPrivate: KeyObject
}

export interface DeviceSeeds {
  sign: Buffer
  box: Buffer
}

export interface Registration {
  signPub: string
  boxPub: string
  proof: string
}

function privateFromSeed(prefix: Buffer, seed: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8' })
}

function publicBytes(key: KeyObject): Buffer {
  const jwk = createPublicKey(key).export({ format: 'jwk' })
  return Buffer.from(jwk.x ?? '', 'base64url')
}

function seedBytes(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: 'jwk' }).d ?? '', 'base64url')
}

export function keysFromSeeds({ sign: signSeed, box }: DeviceSeeds): DeviceKeys | null {
  if (signSeed.length !== SEED_BYTES || box.length !== SEED_BYTES) return null
  return {
    signPrivate: privateFromSeed(PKCS8_ED25519, signSeed),
    boxPrivate: privateFromSeed(PKCS8_X25519, box),
  }
}

export function generateDeviceKeys(): DeviceKeys {
  return {
    signPrivate: generateKeyPairSync('ed25519').privateKey,
    boxPrivate: privateFromSeed(PKCS8_X25519, randomBytes(SEED_BYTES)),
  }
}

export function seedsOf(keys: DeviceKeys): DeviceSeeds {
  return { sign: seedBytes(keys.signPrivate), box: seedBytes(keys.boxPrivate) }
}

export function registrationOf(keys: DeviceKeys): Registration {
  const signPub = publicBytes(keys.signPrivate).toString('base64url')
  const boxPub = publicBytes(keys.boxPrivate).toString('base64url')
  const message = `${REGISTER_CONTEXT}\n${signPub}\n${boxPub}`
  return {
    signPub,
    boxPub,
    proof: sign(null, Buffer.from(message, 'utf8'), keys.signPrivate).toString('base64url'),
  }
}

export function signChallenge(keys: DeviceKeys, deviceId: string, nonce: string): string {
  const message = `${CHALLENGE_CONTEXT}\n${deviceId}\n${nonce}`
  return sign(null, Buffer.from(message, 'utf8'), keys.signPrivate).toString('base64url')
}
