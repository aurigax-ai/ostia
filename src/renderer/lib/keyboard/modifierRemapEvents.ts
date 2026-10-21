import {
  isIdentityRemap,
  type ModifierFlags,
  type ModifierRemap,
  type RemapKey,
  remappedFlags,
  remappedModifierKey,
  sameFlags,
  trackModifierKey,
} from '@shared/keyboard/modifierRemap'

type ModifierEvent = KeyboardEvent | MouseEvent

type FlagReaders = Record<keyof ModifierFlags, (this: ModifierEvent) => boolean>

const FLAG_PROPS = { ctrlKey: 'ctrl', altKey: 'alt', metaKey: 'meta' } as const

const STATE_NAMES = { Control: 'ctrl', Alt: 'alt', Meta: 'meta' } as const

let table: ModifierRemap = {}
let identity = true
const down = new Set<RemapKey>()
const readers = new Map<object, FlagReaders>()

export function setActiveModifierRemap(next: ModifierRemap): void {
  table = next
  identity = isIdentityRemap(next)
}

function readerFor(e: object): FlagReaders | undefined {
  for (const [proto, found] of readers)
    if (Object.prototype.isPrototypeOf.call(proto, e)) return found
  return undefined
}

function realFlags(e: ModifierEvent, read: FlagReaders): ModifierFlags {
  return { ctrl: read.ctrl.call(e), alt: read.alt.call(e), meta: read.meta.call(e) }
}

function effectiveFlags(e: ModifierEvent, read: FlagReaders): ModifierFlags {
  return remappedFlags(table, down, realFlags(e, read))
}

export function isRemappedEvent(e: object): boolean {
  if (identity) return false
  const read = readerFor(e)
  if (!read) return false
  const event = e as ModifierEvent
  return !sameFlags(realFlags(event, read), effectiveFlags(event, read))
}

function patchProperty(
  proto: object,
  name: string,
  make: (original: PropertyDescriptor) => PropertyDescriptor,
) {
  const original = Object.getOwnPropertyDescriptor(proto, name)
  if (!original) throw new Error(`${name} is not an own property of ${String(proto)}`)
  Object.defineProperty(proto, name, { ...make(original), configurable: true, enumerable: true })
  return () => Object.defineProperty(proto, name, original)
}

function patchPrototype(proto: object, keyboard: boolean): (() => void)[] {
  const read: Partial<FlagReaders> = {}
  for (const [prop, flag] of Object.entries(FLAG_PROPS)) {
    const get = Object.getOwnPropertyDescriptor(proto, prop)?.get
    if (!get) throw new Error(`${prop} is not an own property of ${String(proto)}`)
    read[flag as keyof ModifierFlags] = get as (this: ModifierEvent) => boolean
  }
  const full = read as FlagReaders
  readers.set(proto, full)
  const undo = Object.entries(FLAG_PROPS).map(([prop, flag]) =>
    patchProperty(proto, prop, (original) => ({
      get(this: ModifierEvent) {
        if (identity) return (original.get as () => boolean).call(this)
        return effectiveFlags(this, full)[flag]
      },
    })),
  )
  undo.push(
    patchProperty(proto, 'getModifierState', (original) => ({
      value(this: ModifierEvent, name: string) {
        const flag = STATE_NAMES[name as keyof typeof STATE_NAMES]
        if (identity || !flag) return (original.value as (n: string) => boolean).call(this, name)
        return effectiveFlags(this, full)[flag]
      },
      writable: true,
    })),
  )
  if (keyboard) {
    undo.push(
      patchProperty(proto, 'key', (original) => ({
        get(this: KeyboardEvent) {
          const real = (original.get as () => string).call(this)
          return identity ? real : (remappedModifierKey(table, this.code) ?? real)
        },
      })),
    )
  }
  return undo
}

export function installModifierRemap(): () => void {
  const track = (e: KeyboardEvent): void => trackModifierKey(down, e.code, e.type === 'keydown')
  const release = (): void => down.clear()
  window.addEventListener('keydown', track, true)
  window.addEventListener('keyup', track, true)
  window.addEventListener('blur', release)
  const undo = [
    ...patchPrototype(KeyboardEvent.prototype, true),
    ...patchPrototype(MouseEvent.prototype, false),
  ]
  return () => {
    window.removeEventListener('keydown', track, true)
    window.removeEventListener('keyup', track, true)
    window.removeEventListener('blur', release)
    for (const off of undo) off()
    readers.clear()
    down.clear()
    setActiveModifierRemap({})
  }
}
