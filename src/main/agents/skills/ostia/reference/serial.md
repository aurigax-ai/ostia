# Serial consoles

```sh
ostia serial ls                                   # {devices: ["/dev/cu.usbserial-A10K2", ...]}
ostia serial connect /dev/cu.usbserial-A10K2      # 115200 8N1
ostia serial connect /dev/ttyUSB0 9600 7E1        # speed, then frame: data bits, N/E/O, stop bits
ostia serial connect /dev/ttyUSB0 --log sw1.log   # also keep a session log
```

`connect` opens a terminal beside your pane connected to the device, at once and without asking
the human, and prints `{device, speed, frame, paneId}`. Only serial devices are accepted
(`/dev/cu.*` on macOS, `/dev/ttyUSB*` and `/dev/ttyACM*` on Linux), and a sandboxed workspace
is refused. Talk to the device through that pane: `ostia pane send <paneId> "show version"
--enter` types into it and `ostia pane read <paneId>` returns its screen. The human types in
the same connection. The pane prints why when the device is busy (another program holds it),
missing or unplugged, and ends. Closing the pane releases the device; Ctrl-] disconnects.

`--log <name>` takes a file name only (letters, digits, `.`, `_`, `-`; no path, no `..`); the log
is appended to in the serial extension's own logs folder, and `connect` prints its full path as
`log`. A path is refused, here and in the picker: every log lives in that folder, and
`ostia serial logs` shows it in the file manager and prints `{dir}`. Everything the pane sends
and receives goes into the log, including what you type with `ostia pane send`.

Ask the human to type a password themselves. When you must send one, first send the single
byte 0x1c (`Ctrl-\`) with shell ANSI-C quoting, `ostia pane send <paneId> $'\x1c'` (zsh and
bash); `"\x1c"` in double quotes sends four characters and does nothing. The input up to the
next Enter still reaches the device, but neither it nor the device's echo of it is logged or
shown in the pane. The password you send stays in your own transcript, and when Ostia asks the
human to approve your `pane.input` access, the request shows the text you are typing.
