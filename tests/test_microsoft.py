import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from invoice_sorter import app
from invoice_sorter.config import Config, load_config
from invoice_sorter.db import Database
from invoice_sorter.microsoft import MicrosoftAccount, SignInError, iter_mailbox
from invoice_sorter.pipeline import fetch

from .conftest import SAMPLES

CLIENT = "11111111-2222-3333-4444-555555555555"
TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class FakeMicrosoft(BaseHTTPRequestHandler):
    polls = 0
    pages = []

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        form = dict(urllib.parse.parse_qsl(self.rfile.read(int(self.headers["Content-Length"])).decode()))
        assert form["client_id"] == CLIENT and f"/{TENANT}/" in self.path
        if self.path.endswith("/devicecode"):
            assert "Mail.Read" in form["scope"]
            return self._json({"user_code": "ABCD-EFGH", "device_code": "dev", "interval": 0, "expires_in": 60,
                               "verification_uri": "https://microsoft.com/devicelogin"})
        if form["grant_type"].endswith("device_code"):
            FakeMicrosoft.polls += 1
            if FakeMicrosoft.polls < 2:
                return self._json({"error": "authorization_pending"}, 400)
            return self._json({"access_token": "tok1", "refresh_token": "ref1", "expires_in": 3600})
        if form["grant_type"] == "refresh_token":
            assert form["refresh_token"] == "ref1"
            return self._json({"access_token": "tok2", "expires_in": 3600})

    def do_GET(self):
        assert self.headers["Authorization"].startswith("Bearer tok")
        path = urllib.parse.unquote(self.path)
        if path.startswith("/me?"):
            return self._json({"mail": "travis@coastaledgedesign.com"})
        if path.startswith("/me/messages?") or path.startswith("/page2"):
            return self._json(FakeMicrosoft.pages[1 if path.startswith("/page2") else 0])
        if path.endswith("/$value"):
            key = path.split("/")[3]
            body = SAMPLES[key]
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


@pytest.fixture
def ms(monkeypatch):
    FakeMicrosoft.polls = 0
    server = HTTPServer(("127.0.0.1", 0), FakeMicrosoft)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    FakeMicrosoft.pages = [
        {"value": [
            {"id": "receipt", "subject": "Your Staples receipt", "bodyPreview": "Total: $84.50", "hasAttachments": False,
             "internetMessageId": "<r1@staples.com>"},
            {"id": "newsletter", "subject": "Spring newsletter", "bodyPreview": "trail maps", "hasAttachments": False,
             "internetMessageId": "<n1@parks.gov>"},
        ], "@odata.nextLink": base + "/page2"},
        {"value": [{"id": "ack", "subject": "Re: Invoice INV-2001", "bodyPreview": "payment received",
                    "hasAttachments": False, "internetMessageId": "<a1@abcelectric.com>"}]},
    ]
    real = MicrosoftAccount.__init__

    def patched(self, client_id, tenant, token_file, login_url=base, graph_url=base):
        real(self, client_id, tenant, token_file, login_url, graph_url)

    monkeypatch.setattr(MicrosoftAccount, "__init__", patched)
    monkeypatch.setattr("webbrowser.open", lambda url: True)
    monkeypatch.setattr("time.sleep", lambda s: None)
    yield base
    server.shutdown()


def test_sign_in_then_read_mail(ms, tmp_path):
    acct = MicrosoftAccount(CLIENT, TENANT, tmp_path / "t.json")
    out = []
    acct.sign_in(out.append, open_browser=False, sleep=lambda s: None)
    assert any("ABCD-EFGH" in line for line in out)
    assert json.loads((tmp_path / "t.json").read_text())["refresh_token"] == "ref1"
    raws = list(iter_mailbox(acct, "2026-01-01", is_known=lambda mid: False))
    assert len(raws) == 2  # the newsletter is skipped before downloading
    # Expired access renews itself from the saved sign-in.
    acct2 = MicrosoftAccount(CLIENT, TENANT, tmp_path / "t.json")
    acct2.tokens["expires_at"] = 0
    assert acct2.access_token() == "tok2"


def test_not_signed_in_is_a_clear_error(tmp_path):
    with pytest.raises(SignInError):
        MicrosoftAccount(CLIENT, TENANT, tmp_path / "none.json").access_token()


def test_wizard_microsoft_option(ms, tmp_path, monkeypatch):
    monkeypatch.setenv("PAID_PURCHASES_HOME", str(tmp_path / "home"))
    answers = iter(["Coastal Edge", "3",          # company, keyword mode
                    "1", "n",                     # Microsoft 365, don't open browser
                    "not-a-guid", CLIENT, TENANT, "2026-01-01",
                    "n",                          # no more accounts
                    "6"])                         # exit menu
    out = []
    app.run(ask=lambda q: next(answers), out=out.append)
    cfg = load_config(tmp_path / "home" / "settings.yaml")
    acct = cfg.accounts[0]
    assert (acct.type, acct.client_id, acct.tenant, acct.username) == ("microsoft365", CLIENT, TENANT,
                                                                         "travis@coastaledgedesign.com")
    assert any("doesn't look right" in line for line in out)
    db = Database(cfg.db_path)
    assert fetch(cfg, db, log=lambda *_: None) == 2
    assert fetch(cfg, db, log=lambda *_: None) == 0  # nothing new the second time
    db.close()
