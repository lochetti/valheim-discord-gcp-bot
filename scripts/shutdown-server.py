#!/usr/bin/env python3
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

BUCKET = os.environ.get("BUCKET", "")
PORT = 8080
shutdown_lock = threading.Lock()


def run_stop() -> None:
    if not shutdown_lock.acquire(blocking=False):
        return
    try:
        env = os.environ.copy()
        env["BUCKET"] = BUCKET
        subprocess.run(["/opt/valheim/stop.sh"], env=env, check=False)
    finally:
        shutdown_lock.release()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path == "/shutdown":
            self.send_response(202)
            self.end_headers()
            threading.Thread(target=run_stop, daemon=False).start()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        print(f"[shutdown-server] {format % args}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[shutdown-server] Listening on :{PORT}")
    server.serve_forever()
