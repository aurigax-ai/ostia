import type { ExtensionIcon } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import {
  ArrowClockwiseIcon,
  BellIcon,
  BookOpenIcon,
  ChatCircleDotsIcon,
  CheckIcon,
  CircleIcon,
  GitBranchIcon,
  GlobeIcon,
  GraphIcon,
  HardDrivesIcon,
  type Icon as IconComponent,
  KanbanIcon,
  MagnifyingGlassIcon,
  PlugsIcon,
  PlusIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  TerminalWindowIcon,
  ToolboxIcon,
  WarningIcon,
} from '@phosphor-icons/react'

const ICONS: Record<ExtensionIcon, IconComponent> = {
  puzzle: PuzzlePieceIcon,
  kanban: KanbanIcon,
  'book-open': BookOpenIcon,
  'git-branch': GitBranchIcon,
  globe: GlobeIcon,
  bell: BellIcon,
  server: HardDrivesIcon,
  terminal: TerminalWindowIcon,
  circle: CircleIcon,
  check: CheckIcon,
  alert: WarningIcon,
  shield: ShieldCheckIcon,
  chat: ChatCircleDotsIcon,
  plugs: PlugsIcon,
  'magnifying-glass': MagnifyingGlassIcon,
  graph: GraphIcon,
  toolbox: ToolboxIcon,
  plus: PlusIcon,
  refresh: ArrowClockwiseIcon,
}

export function extensionIcon(icon: ExtensionIcon | undefined): IconComponent {
  return icon ? ICONS[icon] : PuzzlePieceIcon
}
