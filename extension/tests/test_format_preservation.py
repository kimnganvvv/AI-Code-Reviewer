import functools
import http.server
import json
import re
import threading
from pathlib import Path

import pytest

playwright_api = pytest.importorskip("playwright.sync_api")
expect = playwright_api.expect
sync_playwright = playwright_api.sync_playwright

EXTENSION_DIR = Path(__file__).resolve().parents[1]
HEALTH_ROUTE = re.compile(r"^http://localhost:8000/health.*")
REVIEW_ROUTE = re.compile(r"^http://localhost:8000/review.*")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
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
def page_url():
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        functools.partial(QuietHandler, directory=str(EXTENSION_DIR)),
    )
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/sidepanel/sidepanel.html"
    finally:
        server.shutdown()
        server.server_close()


def test_source_code_and_suggestion_format_are_preserved(page_url):
    source_code = (
        "\n"
        "# Tiếng Việt ✓\n"
        "import subprocess\r\n"
        "\r\n"
        "def render(cmd):\r\n"
        '    doc = """first line  \r\n'
        'second line"""\r\n'
        "\tif cmd:  \r\n"
        "\t\treturn subprocess.call(cmd, shell=True)  \r\n"
        "    return doc\r\n"
        'html_note = "<script>alert(\'source\')</script>"\r\n'
        "\r\n"
    )
    suggestion = 'if True:\n\tvalue = "<script>alert(1)</script>"  \n'

    requests = []
    response = {"issues": [], "meta": {"mode": "bandit"}}
    next_action = {"value": "fulfill"}

    with sync_playwright() as playwright:
        browser = launch_chromium(playwright)
        context = browser.new_context()
        pending_state = json.dumps(
            {
                "pendingCode": source_code,
                "pendingCodeNotice": "",
                "pendingTabSize": "6",
            },
            ensure_ascii=False,
        )
        context.add_init_script(
            f"""
            window.__sessionState = {pending_state};
            window.__storageListeners = [];
            window.chrome = {{
              storage: {{
                local: {{
                  get: async () => ({{ settings: {{ mode: "bandit" }} }}),
                  set: async () => {{}}
                }},
                session: {{
                  get: async () => ({{ settings: {{ mode: "bandit" }}, ...window.__sessionState }}),
                  set: async (values) => {{ Object.assign(window.__sessionState, values); }}
                }},
                onChanged: {{
                  addListener: (fn) => window.__storageListeners.push(fn)
                }}
              }},
              runtime: {{
                getURL: (path) => "/" + path
              }}
            }};
            window.__emitStorage = (changes) =>
              window.__storageListeners.forEach((fn) => fn(changes, "session"));
            """
        )
        page = context.new_page()

        page.route(
            HEALTH_ROUTE,
            lambda route: route.fulfill(
                status=200,
                headers={
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                },
                body='{"status":"ok","llm_enabled":true,"max_code_length":20000}',
            ),
        )

        def handle_review(route):
            requests.append(json.loads(route.request.post_data))
            if next_action["value"] == "abort":
                route.abort()
                return
            route.fulfill(
                status=200,
                headers={
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                },
                body=json.dumps(response, ensure_ascii=False),
            )

        page.route(REVIEW_ROUTE, handle_review)
        page.goto(page_url)
        page.wait_for_load_state("networkidle")

        code_input = page.locator("#code-input")
        assert code_input.input_value() == source_code
        assert code_input.evaluate("element => element.scrollTop") == 0
        code_input.fill(source_code)
        textarea_value = code_input.input_value()

        page.locator("#btn-analyze").click()
        expect(page.locator("#banner .banner-ok")).to_be_visible()
        assert len(requests) == 1
        assert requests[0]["code"] == textarea_value
        assert requests[0]["code"].startswith("\n")
        assert requests[0]["code"].endswith("\n\n")
        assert 'first line  \n' in requests[0]["code"]
        assert "\t\treturn subprocess.call" in requests[0]["code"]
        assert "Tiếng Việt ✓" in requests[0]["code"]

        code_input.fill("")
        page.locator("#btn-analyze").click()
        expect(page.locator("#banner .banner-title")).to_have_text("Chưa có mã nguồn")

        code_input.fill("   ")
        page.locator("#btn-analyze").click()
        expect(page.locator("#banner .banner-title")).to_have_text("Chưa có mã nguồn")

        code_input.fill("\n\t  ")
        page.locator("#btn-analyze").click()
        expect(page.locator("#banner .banner-title")).to_have_text("Chưa có mã nguồn")
        assert len(requests) == 1

        next_action["value"] = "abort"
        code_input.fill(source_code)
        page.locator("#btn-analyze").click()
        expect(page.locator("#banner .banner-err")).to_be_visible()

        next_action["value"] = "fulfill"
        page.locator("#banner .banner-actions button").click()
        expect(page.locator("#banner .banner-ok")).to_be_visible()
        assert len(requests) == 3
        assert requests[2]["code"] == textarea_value

        response = {
            "issues": [
                {
                    "line": 1,
                    "type": "bug",
                    "severity": "medium",
                    "confidence": "high",
                    "cwe_id": None,
                    "message": "Format check",
                    "explanation": "Suggestion must keep whitespace.",
                    "suggestion": suggestion,
                    "source": "llm",
                }
            ],
            "meta": {"mode": "bandit"},
        }
        code_input.fill("print('suggestion')\n")
        page.locator("#btn-analyze").click()
        suggestion_node = page.locator("#issues pre.suggestion")
        expect(suggestion_node).to_have_count(1)
        assert suggestion_node.text_content() == suggestion
        assert '<script>alert(1)</script>' in suggestion_node.text_content()
        assert page.locator("#issues .suggestion script").count() == 0
        assert page.locator("#issues .suggestion img").count() == 0

        browser.close()
