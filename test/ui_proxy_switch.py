"""The proxy switch must survive the console's own polling.

Reported bug: click the switch, and about two seconds later it flips back off,
so there is no chance to type an address. The console re-reads settings on a
2-second timer; the old render wrote the saved state straight into the controls,
overwriting the user's unsaved edit.

Also covers the log flood: an empty roster used to retry both listings on every
poll, one failed connection pair every two seconds, forever.

Run:  python test/ui_proxy_switch.py
"""

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(port, data_dir):
    env = dict(os.environ, OF_TEST_MODE="1")
    proc = subprocess.Popen(
        ["node", "server.mjs", "--port", str(port), "--data-dir", data_dir, "--no-probe"],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace", env=env,
    )
    # A background reader keeps the pipe from filling and captures the whole run,
    # which is what the retry-rate assertion at the end measures.
    captured = []

    def drain():
        for line in proc.stdout:
            captured.append(line)

    threading.Thread(target=drain, daemon=True).start()

    deadline = time.time() + 25
    while time.time() < deadline:
        if any("local key:" in line for line in captured):
            key = next(line for line in captured if "local key:" in line).split("local key:")[1].split()[0]
            return proc, key, captured
        time.sleep(0.05)
    raise RuntimeError("server did not start:\n" + "".join(captured))


def main():
    port, dead = free_port(), free_port()
    data_dir = tempfile.mkdtemp(prefix="ofm-ui-switch-")
    proc, key, lines = start(port, data_dir)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            page.goto(f"http://127.0.0.1:{port}/")
            page.evaluate(f"sessionStorage.setItem('ofm-key', {json.dumps(key)})")
            page.reload()
            page.wait_for_selector("#models-table", timeout=20000)

            page.click("#dev-options > summary")
            page.wait_for_selector("#px-enabled + .slider", state="visible")

            # 1. Flip the switch on and do nothing. Several poll cycles go by.
            page.click("#px-enabled + .slider")
            page.wait_for_timeout(6000)          # three 2-second polls
            assert page.locator("#px-enabled").is_checked(), \
                "the switch snapped back off while the user was about to type an address"
            assert page.locator("#px-url").is_visible(), "the address field must stay open"
            print("switch stayed on across three poll cycles")

            # 2. Type an address slowly, the way a human would.
            page.click("#px-url")
            page.type("#px-url", f"http://127.0.0.1:{dead}", delay=40)
            page.wait_for_timeout(3000)
            assert page.input_value("#px-url") == f"http://127.0.0.1:{dead}", \
                "polling overwrote the address being typed"
            assert page.locator("#px-enabled").is_checked(), "the switch flipped off while typing"
            print("typed address survived a poll")

            # 3. Saving an unreachable proxy keeps the switch on and says why.
            page.click("#px-save")
            page.wait_for_function(
                "document.querySelector('#px-result').textContent.includes('失败')",
                timeout=30000,
            )
            page.wait_for_timeout(3000)
            assert page.locator("#px-enabled").is_checked(), \
                "a saved-but-unreachable proxy must not flip the switch back"
            print("switch stayed on after saving an unreachable proxy")

            # 4. The roster retry is rate limited: no flood of failed listings.
            #    Checked against the server's own log after shutdown, below.
            page.wait_for_timeout(6000)
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(0.3)   # let the reader thread drain what is left
        log_text = "".join(lines)

    failures = re.findall(r"opencode listing failed", log_text)
    print(f"listing failures logged during the run: {len(failures)}")
    # Startup (1) + the save (1) + at most a couple of backed-off retries.
    assert len(failures) <= 6, f"the listing retry is not rate limited: {len(failures)} attempts"
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
