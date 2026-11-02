import ctypes
import json
import socket
import sys

path, token, filtered = sys.argv[1:4]

if filtered == "yes":
    class Insn(ctypes.Structure):
        _fields_ = [
            ("code", ctypes.c_uint16),
            ("jt", ctypes.c_uint8),
            ("jf", ctypes.c_uint8),
            ("k", ctypes.c_uint32),
        ]

    class Prog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_uint16), ("filter", ctypes.POINTER(Insn))]

    libc = ctypes.CDLL(None, use_errno=True)
    insns = (Insn * 1)(Insn(6, 0, 0, 0x7FFF0000))
    prog = Prog(1, insns)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        sys.exit(3)
    if libc.prctl(22, 2, ctypes.byref(prog), 0, 0) != 0:
        sys.exit(4)

sock = socket.socket(socket.AF_UNIX)
sock.connect(path)
reader = sock.makefile("rb")


def call(request_id, method, params):
    body = json.dumps(
        {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
    ).encode()
    sock.sendall(b"Content-Length: %d\r\n\r\n" % len(body) + body)
    length = 0
    while True:
        line = reader.readline().strip()
        if not line:
            break
        name, _, value = line.partition(b":")
        if name.lower() == b"content-length":
            length = int(value)
    return json.loads(reader.read(length))


call(1, "hello", {"token": token})
out = {}
for index, (key, method, params) in enumerate(
    [
        ("run", "process.run", {"cmd": "true"}),
        ("resume", "pane.setResume", {"agent": "codex", "id": "abc"}),
        ("bus", "bus.send", {}),
    ]
):
    reply = call(index + 2, method, params)
    if "error" in reply:
        out[key] = {"ok": False, "e": reply["error"]["message"]}
    else:
        out[key] = {"ok": True}
sys.stdout.write(json.dumps(out))
sock.close()
