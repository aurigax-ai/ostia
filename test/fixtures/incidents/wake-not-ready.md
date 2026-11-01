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
    "hooks": true,
    "redaction": true
  },
  "pane": "P2",
  "trigger": "not-started",
  "events": [
    {
      "k": "call",
      "at": 0,
      "method": "pane.wake",
      "from": "P1",
      "phase": "start"
    },
    {
      "k": "wake",
      "at": 12000,
      "code": "wake-not-ready",
      "ms": 12000
    },
    {
      "k": "call",
      "at": 12010,
      "method": "pane.wake",
      "from": "P1",
      "phase": "end",
      "ms": 12010,
      "code": "not-started"
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
