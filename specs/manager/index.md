# Manager

Status: decisions in progress

Intent: let the human run one agent CLI from a terminal outside Pine that can see and drive the
running Pine, while Pine keeps running in the background with a tray icon. The agent runs in a
Pine pane (the manager workspace); the outside terminal mirrors it. It is not a way for agents
inside Pine to gain more power, and it is not a second control socket for arbitrary clients.

Segments: [tray](tray.md), [portal](portal.md), [identity](identity.md), [mirror](mirror.md).

## Decisions
- **MGR-D1** Running `pine <agent>` from outside Pine while Pine isn't running starts Pine hidden,
  with only its tray icon showing, and then opens the manager. Why: the manager is the UI in that
  case. Governs: portal launch, app startup window visibility.
- **MGR-D2** Each Pine instance has at most one manager workspace. Why: one manager removes a class
  of recursion and makes "which manager" unambiguous. Governs: portal.open, manager workspace.
- **MGR-D3** Opening the manager never asks for approval. It is refused for any caller inside
  Pine, and only works from a terminal outside Pine. Why: the human is the only one outside Pine
  who starts it, and an agent inside Pine must never reach it. Governs: portal.open, caller check.
- **MGR-D4** Inside Pine, the manager pane is view-only: the human can scroll, select and copy, but
  nothing Pine shows types into it. Input comes only from the outside mirror. Why: one input
  source, and the mirror alone sets the pty size. Governs: manager pane input, pty size.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|

## Open
