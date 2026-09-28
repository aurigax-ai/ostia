if (!('AnimationEvent' in globalThis)) {
  class AnimationEventPolyfill extends Event {
    readonly animationName: string
    readonly elapsedTime: number
    readonly pseudoElement: string

    constructor(type: string, init: AnimationEventInit = {}) {
      super(type, init)
      this.animationName = init.animationName ?? ''
      this.elapsedTime = init.elapsedTime ?? 0
      this.pseudoElement = init.pseudoElement ?? ''
    }
  }
  globalThis.AnimationEvent = AnimationEventPolyfill as unknown as typeof AnimationEvent
}
