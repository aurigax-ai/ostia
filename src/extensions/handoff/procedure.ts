import { GATHER_MAX_CHARS } from './gather'
import type { Ticket } from './tickets'

export const BRIEF_MAX_CHARS = 6000
const CLAIMS_PER_READER = 40
export const CLAIMS_CHECKED = 25

export function startPrompt(ticketId: string): string {
  return `Run \`ostia handoff intake ${ticketId}\` and follow what it prints.`
}

const READER_PROMPT = `You read past Claude Code sessions and return everything about one named task as claims. You do not check whether a claim is true; someone else does.

Read with \`ostia handoff timeline <id> [<id> ...]\` (add --all when a session is from another project). Lines are USER: (typed by the human), USER ANSWER: (the human's pick in a question), AGENT: (the agent's reply) and RUN <tool>: <input> → ok|error | <last output line>. A session can cover many tasks: keep only the lines that belong to the named task, including where it started, changed direction or was dropped. If the timeline is long, read it in parts.

Return at most ${CLAIMS_PER_READER} claims in this shape, each with its timestamp:

TASK: <the task as the human described it, quoted>
SESSIONS: <ids and time ranges read>
USER SAID
- [time] "quote" — what it decides
AGENT SAID
- [time] claim — the RUN line or reply it comes from
DONE
- [time] step → result (still standing | undone at [time])
SUPERSEDED
- [time] old → [time] new (new wins)
OPEN
- item
CHECKS
- one concrete command or file that verifies each DONE and AGENT SAID claim

Never fill a gap with a guess; if the timeline does not say, the claim goes under OPEN.`

const GROUND_PROMPT = `You check claims against the repository and the machine, one claim, one check, each with an evidence line. Run the check (test -f, git show --stat, git log, rg -n, gh pr view --json state) and tag the claim:
[verified] the check shows it
[wrong] the check shows the opposite
[unverified] you could not check it (say why)
Keep [user said] and [agent said] on claims that came from the sessions. Check at most ${CLAIMS_CHECKED} claims and mark the rest "[unverified] not checked". A claim about another project than the current folder is "[unverified] other project" unless you can read it. Change nothing; read only.`

const BRIEF_SHAPE = `---
topic: <one line>
caller_session: <session id>
git_sha: <short sha of HEAD>
sources: <session ids read>
---
# Goal
The human's own words.
# Where it stands
A few lines, only [verified] facts.
# Claims
| claim | tag | evidence |
# Decisions to keep
Only what the human said. [agent said] items appear here as proposals, never as settled.
# Needs your call
What is still open and only the human can decide.
# Related files
At most 15 paths.
# Next step
One concrete step.`

export function intakeText(ticket: Ticket, folder: string): string {
  return `handoff ${ticket.id}
topic: ${ticket.topic}
caller: ${ticket.agent} session ${ticket.sessionId}, folder ${ticket.workDir}
folder: ${folder}
brief: $OSTIA_ARTIFACTS/handoff-<slug>.md

You are a fresh session. A different session handed this topic to you. Its transcript is not in your context and must not enter it: read it only through subagents. Do not message, ask or report to the caller. Follow these steps in order.

1. Pin. Restate the topic in one line. Make a short lowercase slug from it for the brief file name.
2. Find. Run \`ostia handoff find "<2 to 4 specific words>"\`. It ranks this folder's sessions, worktrees included, and lists the caller's session first. Keep the caller's session and the ones clearly about the topic. Add --all only to search every project; it asks the human first.
3. Read, in parallel subagents, one per kept session.
   - If your agent types include a session-reader (from a recall plugin), use it. Tell it the ids and that it reads with \`ostia handoff timeline <ids>\`.
   - Otherwise start one general-purpose subagent per session, model sonnet, with this prompt (add the topic and the session id):
${indent(READER_PROMPT)}
   - Never read a timeline yourself.
4. Gather. Run \`ostia handoff gather "<the same words>"\` once. It prints at most ${GATHER_MAX_CHARS} characters of commits, changes and files that mention the topic.
5. Ground. Start one general-purpose subagent, model sonnet, with the readers' claims and this prompt:
${indent(GROUND_PROMPT)}
   Then re-check only the [wrong] claims and the decisions yourself, in one batched Bash call. Drop superseded decisions. A decision tagged [agent said] stays a proposal.
6. Brief. Write at most ${BRIEF_MAX_CHARS} characters to $OSTIA_ARTIFACTS/handoff-<slug>.md in this shape. If $OSTIA_ARTIFACTS is empty, stop and tell the human.
${indent(BRIEF_SHAPE)}
7. Ask or go on. If "Needs your call" has lines, show them and ask the human once. Otherwise start the next step. From here the brief is your only memory of the past: after /compact or /clear, read it again.`
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `     ${l}`)
    .join('\n')
}
