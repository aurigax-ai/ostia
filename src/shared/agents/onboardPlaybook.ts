import skill from './playbooks/onboard/SKILL.md?raw'
import cleanup from './playbooks/onboard/steps/cleanup.md?raw'
import dispatch from './playbooks/onboard/steps/dispatch.md?raw'
import issue from './playbooks/onboard/steps/issue.md?raw'
import limits from './playbooks/onboard/steps/limits.md?raw'
import merge from './playbooks/onboard/steps/merge.md?raw'
import name from './playbooks/onboard/steps/name.md?raw'
import pr from './playbooks/onboard/steps/pr.md?raw'
import report from './playbooks/onboard/steps/report.md?raw'
import review from './playbooks/onboard/steps/review.md?raw'
import scout from './playbooks/onboard/steps/scout.md?raw'
import test from './playbooks/onboard/steps/test.md?raw'
import watch from './playbooks/onboard/steps/watch.md?raw'
import worktree from './playbooks/onboard/steps/worktree.md?raw'

export interface PlaybookExtraFile {
  path: string
  text: string
}

const STEPS: Readonly<Record<string, string>> = {
  cleanup,
  dispatch,
  issue,
  limits,
  merge,
  name,
  pr,
  report,
  review,
  scout,
  test,
  watch,
  worktree,
}

export const ONBOARD_TEXT = skill

export const ONBOARD_FILES: readonly PlaybookExtraFile[] = Object.entries(STEPS).map(
  ([step, text]) => ({ path: `steps/${step}.md`, text }),
)
