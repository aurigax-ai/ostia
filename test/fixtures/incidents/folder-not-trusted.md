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
  "trigger": "folder-not-trusted",
  "events": [
    {
      "k": "call",
      "at": 0,
      "method": "agent.run",
      "phase": "start"
    },
    {
      "k": "call",
      "at": 20,
      "method": "agent.run",
      "phase": "end",
      "ms": 20,
      "code": "folder-not-trusted"
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
