# Serial consoles

```sh
ostia serial ls                                   # {devices: ["/dev/cu.usbserial-A10K2", ...]}
ostia serial connect /dev/cu.usbserial-A10K2      # 115200 8N1
ostia serial connect /dev/ttyUSB0 9600 7E1        # speed, then frame: data bits, N/E/O, stop bits
```

`connect` opens a terminal beside your pane connected to the device, at once and without asking
the human, and prints `{device, speed, frame, paneId}`. Only serial devices are accepted
(`/dev/cu.*` on macOS, `/dev/ttyUSB*` and `/dev/ttyACM*` on Linux), and a sandboxed workspace
is refused. Talk to the device through that pane: `ostia pane send <paneId> "show version"
--enter` types into it and `ostia pane read <paneId>` returns its screen. The human types in
the same connection. The pane prints why when the device is busy (another program holds it),
missing or unplugged, and ends. Closing the pane releases the device; Ctrl-] disconnects.
