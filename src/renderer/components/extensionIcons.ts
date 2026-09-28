import type { ExtensionIcon } from '@shared/extensions'
import {
  Bell,
  BookOpen,
  Check,
  Circle,
  GitBranch,
  Globe,
  Kanban,
  type LucideIcon,
  Puzzle,
  Server,
  ShieldCheck,
  Terminal,
  TriangleAlert,
} from 'lucide-react'

const ICONS: Record<ExtensionIcon, LucideIcon> = {
  puzzle: Puzzle,
  kanban: Kanban,
  'book-open': BookOpen,
  'git-branch': GitBranch,
  globe: Globe,
  bell: Bell,
  server: Server,
  terminal: Terminal,
  circle: Circle,
  check: Check,
  alert: TriangleAlert,
  shield: ShieldCheck,
}

export function extensionIcon(icon: ExtensionIcon | undefined): LucideIcon {
  return icon ? ICONS[icon] : Puzzle
}
