import { vi } from 'vitest'

export function pushDepsStub() {
  return {
    push: {
      ticket: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
      hello: vi.fn().mockReturnValue(undefined),
    },
    waitingSince: vi.fn().mockReturnValue(undefined),
    sessionWaitingSince: vi.fn().mockReturnValue(undefined),
  }
}
