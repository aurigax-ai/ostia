import http.server
import sys

root, log, port = sys.argv[1], sys.argv[2], int(sys.argv[3])


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=root, **kwargs)

    def do_GET(self):
        with open(log, "a") as handle:
            handle.write(f"{self.path} cookie={self.headers.get('Cookie')}\n")
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        if "srv=" not in (self.headers.get("Cookie") or ""):
            self.send_header("Set-Cookie", "srv=1; Max-Age=99999; Path=/")
        super().end_headers()

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
