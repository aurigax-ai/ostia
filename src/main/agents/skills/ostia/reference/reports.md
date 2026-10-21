# Reports the human sends

## Contents

- How a report arrives
- Element captures
- Region captures
- Selections from files and terminals
- Redacted values

## How a report arrives

The human can send what they point at to a pane. Ostia writes a markdown report into
`/tmp/ostia-reports-<uid>/` and then:

- pastes `@<report path> ` at the pane's prompt when it is an idle shell prompt or its agent
  reported `waiting` or `done`, followed by `@<screenshot>.png ` when the human left Settings →
  Browser → Attach the screenshot on; otherwise the references go to the human's clipboard.
  Ostia never presses Enter after pasting; the human reads the reference and sends it;
- puts a bus message in the pane's inbox whose `text` is JSON describing the report (it marks
  nothing unread and is not repeated in prompt context);
- sets the pane's attention to `working`.

A path pasted alone (`@<path> `, from **Send path to agent**) is the file itself, not a report.

## Element captures

**Point at element** in a browser pane's toolbar writes `capture-N-<page>.md` (`<page>` is the
host and path). The bus message is
`{"kind":"capture","report":"<path>","image":"<png>|null","url":"…","selector":"…","note":"…"}`.
The report holds the human's note, the page URL and title, a CSS selector, role and name, box,
a subset of computed styles, the element's outerHTML (at most 2 KB), recent console errors,
failed requests, and the screenshot (the element plus 16 CSS px around it) as a path and an
embedded image. `ostia browse get styles '<selector>'` reads more from the page.

## Region captures

**Capture region** writes `capture-N-<page>.png` and `capture-N-<page>.md` (title, URL, the
region in CSS px, the image size, the note, the image). Its bus message has
`"region":{x,y,width,height}` instead of `selector`.

## Selections from files and terminals

**Send Selection to Agent** (text in the editor or Markdown preview, a region of an image, text
or a region of a PDF page) and a terminal's selected text or a command block's **Send output to
agent…** write `selection-N.md`, plus `selection-N.png` for image and PDF regions. The bus
message is `{"kind":"selection","report":"<path>","file":"<path>|null","image":"<png>|null","note":"…"}`
(`file` is null for terminal text).

The report's title names the kind (`Text selection`, `Image region`, `PDF text selection`,
`PDF page region`, `Terminal text`, `Terminal output`), then the note, then `## Source`:

| Kind | Source |
|---|---|
| text | `File` and `Lines` (`12:5-14:1`, 1-based line:column, end exclusive; the Markdown preview gives `12-14`); the text in a fenced block |
| image region | `File`, the image size and `Region` in image pixels; a `Snapshot` PNG |
| PDF | `File`, `Pages`, or `Page` with its size and `Region` in PDF points (origin top-left); a `Snapshot` PNG |
| terminal | `Directory`, and for a block the `Command`; the text under `## Terminal text` |

The report is a copy; the file at `File` is the source.

## Redacted values

`[redacted:<kind>]` (`[redacted:github]`, `[redacted:assignment]`, …) marks where the human's
text held a secret; Ostia removes secrets from what it writes for agents. The value is in the
file at `File`, or with the human.
