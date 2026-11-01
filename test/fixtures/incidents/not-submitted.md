## What happened
I sent the worker a message and it sat at its prompt.

## What I expected
It reads the message and starts working.

```ostia-incident json
{
  "version": 1,
  "app": "0.0.0",
  "platform": "linux",
  "agent": { "kind": "claude" },
  "settings": { "hooks": true, "redaction": true },
  "pane": "P1",
  "trigger": "not-submitted",
  "events": [
    {
      "k": "call",
      "at": 0,
      "method": "pane.input",
      "from": "P2",
      "phase": "start",
      "before": { "agent": "claude", "state": "waiting", "drafting": true, "mail": 0 }
    },
    {
      "k": "call",
      "at": 4800,
      "method": "pane.input",
      "from": "P2",
      "phase": "end",
      "ms": 4800,
      "code": "not-submitted",
      "after": { "agent": "claude", "state": "waiting", "drafting": true, "mail": 0 }
    }
  ],
  "unseen": ["agent-internals", "terminal-text"],
  "counts": { "calls": 1, "failed": 1 }
}
```
