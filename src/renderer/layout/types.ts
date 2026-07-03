/** Layout model (docs/ARCHITECTURE.md §5.10): a recursive split-tree of single-surface panes. */

/** Axis a split arranges its children along. */
export type Direction = 'horizontal' | 'vertical'

/** What a pane hosts — picks its header icon. */
export type SurfaceKind = 'terminal' | 'editor' | 'agent' | 'browser'

/**
 * A leaf: one pane holding one surface (Warp-style — a header over a terminal/editor/…,
 * no tab bar). More surfaces come from splitting, or from another sidebar session.
 */
export interface PaneNode {
  type: 'pane'
  id: string
  title: string
  kind: SurfaceKind
  /**
   * The pane's current working directory. Starts at its session's workDir anchor and
   * follows the shell (terminal panes). Drives the Files explorer when this pane is
   * focused. Falls back to the session workDir when undefined.
   */
  cwd?: string
  /** For `editor` panes: the absolute path of the open file. */
  filePath?: string
}

/** An internal node: a split with N children and their proportional sizes. */
export interface SplitNode {
  type: 'split'
  id: string
  direction: Direction
  children: LayoutNode[]
  /** One weight per child; relative, not pixels. */
  sizes: number[]
}

export type LayoutNode = PaneNode | SplitNode

/** Where a dragged pane lands relative to a target pane. */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'
