export const HUD_IDLE_MS = 2500

export interface HudInputs {
  paused: boolean
  active: boolean
  hovered: boolean
  focusWithin: boolean
  menuOpen: boolean
}

export function hudVisible(inputs: HudInputs): boolean {
  return inputs.paused || inputs.active || inputs.hovered || inputs.focusWithin || inputs.menuOpen
}
