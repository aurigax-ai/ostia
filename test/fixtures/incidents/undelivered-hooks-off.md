## What happened
recorded fixture

## What I expected
it works

```ostia-incident json
{
  "version": 1,
  "app": "0.0.0",
  "platform": "linux",
  "agent": {
    "kind": "claude"
  },
  "settings": {
    "hooks": false,
    "redaction": true
  },
  "pane": "P2",
  "trigger": "undelivered-hooks-off",
  "events": [
    {
      "k": "call",
      "at": 0,
      "method": "bus.send",
      "from": "P1",
      "phase": "start"
    },
    {
      "k": "mail",
      "at": 30,
      "code": "undelivered-hooks-off",
      "age": 0
    },
    {
      "k": "call",
      "at": 40,
      "method": "bus.send",
      "from": "P1",
      "phase": "end",
      "ms": 40
    }
  ],
  "unseen": [
    "agent-internals",
    "terminal-text"
  ],
  "counts": {
    "pane.input.ok": 14,
    "pane.input.not-submitted": 1
  },
  "sinceMin": 42
}
```
