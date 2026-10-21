export interface PillBase {
  id: string
  label: string
  chord?: string
  disabled?: boolean
}

export interface PillButton extends PillBase {
  type: 'button'
  icon: string
  onClick: () => void
}

export interface PillToggle extends PillBase {
  type: 'toggle'
  icon: string
  pressed?: boolean
  onToggle: (pressed: boolean) => void
}

export interface PillMenuItem {
  id: string
  label: string
  chord?: string
}

export interface PillMenu extends PillBase {
  type: 'menu'
  text: string
  items: PillMenuItem[][]
  checked?: string
  onPick: (id: string) => void
}

export interface PillStep {
  label: string
  chord?: string
}

export interface PillPager extends PillBase {
  type: 'pager'
  page: number
  count: number
  of: (count: number) => string
  previous: PillStep
  next: PillStep
  onGo: (page: number) => void
}

export interface PillFindLabels {
  placeholder: string
  matchCase: string
  highlightAll: string
  previous: string
  next: string
  done: string
  none: string
  count: (index: number, total: number) => string
}

export interface FindOptions {
  matchCase: boolean
  highlightAll: boolean
}

export interface PillFind extends PillBase {
  type: 'find'
  icon: string
  labels: PillFindLabels
  onQuery: (query: string, options: FindOptions) => void
  onStep: (direction: 1 | -1) => void
  onClose: () => void
}

export type PillControl = PillButton | PillToggle | PillMenu | PillPager | PillFind

export interface PillOptions {
  label: string
  controls: PillControl[]
  page?: HTMLElement
  parent?: HTMLElement
}

export interface PillStatePatch {
  disabled?: boolean
  pressed?: boolean
  text?: string
  checked?: string | null
  page?: number
  count?: number
}

export interface FindHandle {
  open: () => void
  close: () => void
  isOpen: () => boolean
  setResult: (result: { index: number; total: number }) => void
}

export interface Pill {
  element: HTMLElement
  setState: (id: string, patch: PillStatePatch) => void
  setHidden: (hidden: boolean) => void
  find: FindHandle
  destroy: () => void
}

export type Update = (patch: PillStatePatch) => void

export interface Built {
  node: HTMLElement
  update: Update
}
