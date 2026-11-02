import os
import sys
import time

root = int(sys.argv[1])
path = sys.argv[2]
ticks = os.sysconf("SC_CLK_TCK")
page = os.sysconf("SC_PAGE_SIZE")


def children():
    parents = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat") as handle:
                data = handle.read()
        except OSError:
            continue
        rest = data[data.rindex(")") + 2 :].split()
        parents[int(name)] = (int(rest[1]), int(rest[11]) + int(rest[12]), int(rest[21]), data)
    tree = {root}
    changed = True
    while changed:
        changed = False
        for pid, (ppid, _, _, _) in parents.items():
            if ppid in tree and pid not in tree:
                tree.add(pid)
                changed = True
    return {pid: parents[pid] for pid in tree if pid in parents}


def pss_kb(pid):
    try:
        with open(f"/proc/{pid}/smaps_rollup") as handle:
            for line in handle:
                if line.startswith("Pss:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return 0


def kind(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as handle:
            parts = handle.read().split(b"\0")
    except OSError:
        return "?"
    for part in parts:
        if part.startswith(b"--type="):
            return part[7:].decode()
    return "main"


def seccomp(pid):
    try:
        with open(f"/proc/{pid}/status") as handle:
            for line in handle:
                if line.startswith("Seccomp:"):
                    return line.split()[1]
    except OSError:
        pass
    return "?"


previous = {}
last = time.time()
with open(path, "w") as out:
    out.write("t,procs,cpu_pct,rss_mb,pss_mb,seccomp_modes,cpu_by_kind\n")
    start = last
    while True:
        time.sleep(1)
        try:
            tree = children()
        except OSError:
            break
        if root not in tree:
            break
        now = time.time()
        used = 0
        rss = 0
        pss = 0
        modes = []
        by_kind = {}
        for pid, (_, cpu, rss_pages, data) in tree.items():
            delta = cpu - previous.get(pid, cpu)
            used += delta
            by_kind[kind(pid)] = by_kind.get(kind(pid), 0) + delta
            previous[pid] = cpu
            rss += rss_pages * page
            pss += pss_kb(pid) * 1024
            modes.append(seccomp(pid))
        elapsed = now - last
        cpu_pct = 100.0 * used / ticks / elapsed
        last = now
        out.write(f"{now - start:.0f},{len(tree)},{cpu_pct:.1f},{rss / 1048576:.0f},{pss / 1048576:.0f},{''.join(modes)},{';'.join(f'{k}={100.0 * v / ticks / elapsed:.0f}' for k, v in sorted(by_kind.items()))}\n")
        out.flush()
