# Bus: delivery details

`via` of a delivered message is its next prompt, its start, a turn Ostia started, or `inbox --take`
or `wait`. `reason` of a failed one is `pane-closed`, or `expired:<pending>` after 24 hours.
`pending` says why a queued message waits: `working` (read when its turn ends), `idle-will-wake`
(Ostia starts a turn in the idle agent to read it), `draft` (the human has text in its prompt),
`rate-limited` (too many mail turns lately), `idle-no-wake` (read at its next prompt),
`hibernated` (Ostia wakes the agent, at most 3 times an hour, and it reads the message),
`hooks-off` or `no-agent` (read only with `bus inbox`).

A message turns delivered once your command printed it; if that command died first you see it
again. `send` and `handoff` read the store back and answer `not-queued:` or `not-recorded:` when
the message is missing; a receiver with 200 undelivered messages answers `inbox-full`. A sandboxed
workspace reaches only its own panes.

`send` and `handoff` take a pane id or a bus name (`ostia pane name`); a name resolves only to a pane
you reach, so a name held outside your reach answers `unknown-pane`. Mail already queued stays
addressed to the pane that held the name when it was sent.
