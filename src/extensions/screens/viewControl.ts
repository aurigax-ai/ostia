export interface Focusable {
  focus: () => void
}

export interface ViewTarget extends Focusable {
  viewOnly: boolean
  focusOnClick: boolean
}

export interface ViewControlDeps {
  view: ViewTarget
  active: () => Focusable | null
  takeover: () => Promise<boolean>
  giveback: () => Promise<boolean>
}

export class ViewControl {
  private held = false
  private returnTo: Focusable | null = null

  constructor(private readonly deps: ViewControlDeps) {
    this.viewOnly()
  }

  get holding(): boolean {
    return this.held
  }

  async takeOver(): Promise<boolean> {
    const before = this.deps.active()
    if (!(await this.deps.takeover())) return false
    this.held = true
    this.returnTo = before
    this.deps.view.viewOnly = false
    this.deps.view.focusOnClick = true
    this.deps.view.focus()
    return true
  }

  async giveBack(): Promise<boolean> {
    if (!(await this.deps.giveback())) return false
    const returnTo = this.returnTo
    this.released()
    returnTo?.focus()
    return true
  }

  released(): void {
    this.held = false
    this.returnTo = null
    this.viewOnly()
  }

  private viewOnly(): void {
    this.deps.view.viewOnly = true
    this.deps.view.focusOnClick = false
  }
}
