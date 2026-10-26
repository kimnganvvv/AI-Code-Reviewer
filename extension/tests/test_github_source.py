import functools
import http.server
import threading
from pathlib import Path
from typing import ClassVar

import pytest

playwright_api = pytest.importorskip("playwright.sync_api")
sync_playwright = playwright_api.sync_playwright

EXTENSION_DIR = Path(__file__).resolve().parents[1]
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
SOURCE_FIXTURE = FIXTURE_DIR / "github_source.py"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map: ClassVar[dict[str, str]] = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".py": "text/plain; charset=utf-8",
    }

    def log_message(self, _format, *args):
        pass


def launch_chromium(playwright):
    try:
        return playwright.chromium.launch(headless=True, channel="chrome")
    except playwright_api.Error:
        try:
            return playwright.chromium.launch(headless=True)
        except playwright_api.Error as exc:
            pytest.skip(f"Chromium is unavailable: {exc}")


@pytest.fixture()
def base_url():
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        functools.partial(QuietHandler, directory=str(EXTENSION_DIR)),
    )
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def test_github_source_is_read_exactly(base_url):
    raw = SOURCE_FIXTURE.read_text(encoding="utf-8")

    with sync_playwright() as playwright:
        browser = launch_chromium(playwright)
        context = browser.new_context()
        page = context.new_page()
        page.goto(f"{base_url}/tests/fixtures/github_blob.html", wait_until="networkidle")

        data = page.evaluate(
            """
            async () => {
              const mod = await import("/src/github.js");
              const extracted = await mod.extractGithubFileFromPage();
              const raw = extracted.code;
              return {
                extracted,
                whole: mod.chooseGithubCode({
                  selectionText: raw.slice(0, -1),
                  extracted
                }),
                wholeCrlf: mod.chooseGithubCode({
                  selectionText: raw.replace(/\\n/g, "\\r\\n").slice(0, -2),
                  extracted
                }),
                partial: mod.chooseGithubCode({
                  selectionText: "def render(command):",
                  extracted
                }),
                failed: mod.chooseGithubCode({
                  selectionText: "partial selection",
                  extracted: { error: "Không tải được file." }
                }),
                urls: [
                  mod.isGithubBlobUrl(
                    "https://github.com/owner/repo/blob/main/backend/app/main.py#L1"
                  ),
                  mod.isGithubBlobUrl(
                    "https://github.com/owner/repo/tree/main/backend/app"
                  ),
                  mod.isGithubBlobUrl("https://example.com/owner/repo/blob/main/a.py")
                ]
              };
            }
            """
        )

        assert data["extracted"]["code"] == raw
        assert data["extracted"]["tabSize"] == "6"
        assert raw.endswith("\n")
        assert raw.startswith("# -*- coding: utf-8 -*-")
        assert "\t" in raw
        assert 'line one  \n' in raw
        assert "trailing space \n" in raw
        assert "Tiếng Việt ✓" in raw

        assert data["whole"]["code"] == raw
        assert data["whole"]["tabSize"] == "6"
        assert data["whole"]["notice"] == ""
        assert data["wholeCrlf"]["code"] == raw
        assert data["wholeCrlf"]["tabSize"] == "6"
        assert data["partial"]["code"] == "def render(command):"
        assert data["partial"]["tabSize"] == "6"
        assert data["partial"]["notice"] == ""
        assert data["failed"]["code"] == "partial selection"
        assert data["failed"]["tabSize"] == ""
        assert "Không tải được file" in data["failed"]["notice"]
        assert data["urls"] == [True, False, False]

        page.evaluate(
            """() => document.querySelector('a[data-testid="raw-button"]').remove()"""
        )
        no_raw = page.evaluate(
            """
            async () => {
              const mod = await import("/src/github.js");
              return mod.extractGithubFileFromPage();
            }
            """
        )
        assert "Raw" in no_raw["error"]

        browser.close()
