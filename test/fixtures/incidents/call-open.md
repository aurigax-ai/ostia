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
  "pane": "P1",
  "trigger": "call-open",
  "events": [
    {
      "k": "call",
      "at": 0,
      "method": "pane.wait",
      "from": "P2",
      "phase": "start"
    },
    {
      "k": "call",
      "at": 30000,
      "method": "pane.wait",
      "from": "P2",
      "phase": "phase",
      "name": "never-returned",
      "ms": 30000
    }
  ],
  "unseen": [
    "agent-internals",
    "terminal-text"
  ],
  "counts": {
    "calls": 1,
    "failed": 1
  }
}
```
