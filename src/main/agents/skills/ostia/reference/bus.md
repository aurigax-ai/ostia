# Bus: delivery states

Nothing is typed into the receiver. A message is `queued` until the receiver's agent takes it,
`leased` while it is being handed over, then `delivered` (`via`: its next prompt, its start, a turn Ostia started, or `inbox --take` / `wait`), or `failed`
(`reason`: `pane-closed`, or `expired:<pending>` after 24 hours). `pending` says why a queued
message waits: `working` (read when its turn ends), `idle-will-wake` (Ostia starts a turn in the
idle agent to read it), `draft` (the human has text in its prompt), `rate-limited` (too many mail
turns lately), `idle-no-wake` (read at its next prompt), `hibernated` (Ostia wakes the agent, at
most 3 times an hour, and it reads the message), `hooks-off` or `no-agent` (read only with
`bus inbox`). `inbox` and `wait` print the messages whole, framed as the hook frames them, or
`(no messages)`; `wait` answers `timed-out:` with exit 2. A message turns delivered once your command printed it;
if that command died first you see it again, so a repeated message id is a duplicate. Give the shell
command a timeout longer than `--timeout`. `--wait <s>` blocks
(1–590 s) until it is delivered or failed and exits 0 delivered, 1 failed, 2 still queued. `send`
and `handoff` read the store back and answer `not-queued:` or `not-recorded:` when the message
is missing; a receiver with 200 undelivered messages answers `inbox-full`. Sending to another
pane needs `send-other-pane`, plus `all-workspaces` outside your reach; a sandboxed workspace
reaches only its own. `handoffs --all` needs `all-workspaces`.

