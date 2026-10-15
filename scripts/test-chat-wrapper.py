"""Exercise the shipped wrapper against a local HTTP server; never use credentials."""
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest


class WrapperTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="gateway-wrapper-", dir="/var/tmp")
        cls.script = Path(cls.temp.name) / "chat.sh"
        shutil.copyfile(Path(__file__).resolve().parents[1] / "clients/chatgpt-web-skill/chat.sh", cls.script)
        cls.status = 200
        cls.body = {"ok": True, "choices": [{"message": {"content": "OK"}}]}
        cls.headers = None

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                cls.headers = dict(self.headers)
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(cls.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(cls.body).encode())

            def log_message(self, *args):
                pass

        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        (Path(cls.temp.name) / ".env").write_text(
            f"CHATGPT_WEB_URL=http://127.0.0.1:{cls.server.server_port}\nCHATGPT_WEB_USER=test\nCHATGPT_WEB_PASS=test\n"
        )

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp.cleanup()

    def run_wrapper(self, **env):
        return subprocess.run(["bash", str(self.script), "test", "--instant", "--json"], env={**os.environ, **env}, capture_output=True, text=True, timeout=5)

    def test_timeout_header(self):
        type(self).status = 200
        type(self).body = {"choices": [{"message": {"content": "OK"}}]}
        result = self.run_wrapper(CHATGPT_WEB_TIMEOUT_SECONDS="85")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(type(self).headers.get("X-Request-Timeout-Ms"), "85000")

    def test_machine_errors_keep_retry_policy(self):
        for status, kind, code in [(429, "queue_full", 2), (503, "page_load_failed", 1), (503, "login_failed", 4), (504, "request_timeout", 1), (422, "refused", 3)]:
            with self.subTest(kind=kind):
                type(self).status = status
                type(self).body = {"ok": False, "error_kind": kind, "should_retry": kind != "refused", "error": {"message": "test", "retry_after": 45}}
                result = self.run_wrapper()
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual(json.loads(result.stdout), type(self).body)


if __name__ == "__main__":
    unittest.main()
