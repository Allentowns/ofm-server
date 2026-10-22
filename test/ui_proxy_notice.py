"""Does the console tell the truth when the listing fails?

Reproduces the reported situation: this machine cannot reach the upstreams
without a proxy. The test stands up a server whose proxy setting points at a
dead port, opens the console, and checks what a user would actually read.

Run:  python test/ui_proxy_notice.py
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "shots")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_key(proc, timeout=25):
    deadline = time.time() + timeout
    text = ""
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            time.sleep(0.05)
            continue
        text += line
        if "local key:" in line:
            return text.split("local key:")[1].split()[0]
    raise RuntimeError(f"server did not start:\n{text}")


def start(port, data_dir):
    env = dict(os.environ, OF_TEST_MODE="1", PYTHONIOENCODING="utf-8")
    proc = subprocess.Popen(
        ["node", "server.mjs", "--port", str(port), "--data-dir", data_dir, "--no-probe"],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace", env=env,
    )
    return proc, wait_for_key(proc)


def main():
    port = free_port()
    data_dir = tempfile.mkdtemp(prefix="ofm-ui-proxy-")
    proc, key = start(port, data_dir)
    os.makedirs(SHOTS, exist_ok=True)
    dead = free_port()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            page.goto(f"http://127.0.0.1:{port}/")
            page.evaluate(f"sessionStorage.setItem('ofm-key', {json.dumps(key)})")
            page.reload()
            page.wait_for_selector("#models-table tbody tr", timeout=20000)

            # 1. The roster is there before the proxy exists.
            before = page.locator("#models-table tbody tr").count()
            print(f"rows before proxy: {before}")
            assert before > 0, "the fake-free roster should have loaded directly"
            assert page.locator("#models-notice").is_hidden(), "no notice while the listing works"

            # 2. Turn the proxy on, pointing at a port nothing listens on.
            page.click("#dev-options > summary")  # the proxy card lives in the advanced section
            page.wait_for_selector("#px-enabled + .slider", state="visible")
            page.click("#px-enabled + .slider")   # reveal the address field
            page.wait_for_selector("#px-url", state="visible")
            page.fill("#px-url", f"http://127.0.0.1:{dead}")
            page.click("#px-save")
            page.wait_for_function(
                "document.querySelector('#px-result').textContent.includes('保存')"
                " || document.querySelector('#px-result').textContent.includes('已')",
                timeout=30000,
            )
            result = page.locator("#px-result").inner_text()
            print(f"px-result: {result}")
            assert "已保存" in result, f"a broken proxy must not read as 'applied': {result}"
            assert "失败" in result, f"the failure reason is missing: {result}"
            page.screenshot(path=os.path.join(SHOTS, "22-proxy-notice.png"))

            # 3. The switch stays on: the user asked for it, and it may start
            #    working once the address is fixed.
            assert page.locator("#px-enabled").is_checked(), "the switch must stay on after a save"

            # 4. The model table explains itself instead of going blank.
            notice = page.locator("#models-notice")
            assert notice.is_visible(), "a failed listing must be visible above the table"
            notice_text = notice.inner_text()
            print(f"notice: {notice_text}")
            assert "代理" in notice_text, f"the notice should point at the proxy: {notice_text}"
            rows_after = page.locator("#models-table tbody tr").count()
            print(f"rows after broken proxy: {rows_after}")
            assert rows_after == before, "a failed listing must not drop the previous roster"

            # 5. Point it at a working route and the notice clears.
            page.click("#px-enabled + .slider")   # off
            page.wait_for_function(
                "document.querySelector('#px-result').textContent.includes('直连')",
                timeout=30000,
            )
            page.wait_for_timeout(500)
            assert page.locator("#models-notice").is_hidden(), "the notice must clear once the listing works"
            print("switching the proxy off clears the notice")
            page.screenshot(path=os.path.join(SHOTS, "23-proxy-recovered.png"))

            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    print("OK")


if __name__ == "__main__":
    sys.exit(main())

