import sys
import time

start = time.time()
with open(sys.argv[1], "w") as out:
    for line in sys.stdin:
        out.write(f"{time.time() - start:7.2f} {line}")
        out.flush()
