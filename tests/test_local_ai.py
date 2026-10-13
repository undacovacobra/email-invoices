import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from invoice_sorter import app
from invoice_sorter.config import Config
from invoice_sorter.local_ai import EXTRACTION_SCHEMA, LocalAIAnalyzer, Ollama
from invoice_sorter.parsing import parse_email

from .conftest import SAMPLES


class FakeOllama(BaseHTTPRequestHandler):
    models = []
    chats = []

    def log_message(self, *a):
        pass

    def _send(self, obj, ndjson=False):
        body = ("\n".join(json.dumps(o) for o in obj) if ndjson else json.dumps(obj)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send({"models": [{"name": m} for m in FakeOllama.models]})

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/api/pull":
            FakeOllama.models.append(req["model"])
            self._send([{"status": "pulling", "total": 100, "completed": 50},
                        {"status": "pulling", "total": 100, "completed": 100}, {"status": "success"}], ndjson=True)
        else:
            FakeOllama.chats.append(req)
            answer = {"doc_type": "receipt", "paid_status": "paid", "paid_evidence": "Paid with Visa", "vendor": "Staples",
                      "amount": 84.5, "currency": "usd", "purchase_date": "2026-03-02", "invoice_number": None,
                      "location": {"city": "Austin", "region": "TX", "country": "US", "address": None},
                      "purpose": "Paper", "project": None, "category": "Office Supplies", "confidence": 0.9, "notes": ""}
            self._send({"message": {"role": "assistant", "content": json.dumps(answer)}, "done": True})


@pytest.fixture
def ollama():
    FakeOllama.models, FakeOllama.chats = [], []
    server = HTTPServer(("127.0.0.1", 0), FakeOllama)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_schema_has_no_refs():
    assert "$ref" not in json.dumps(EXTRACTION_SCHEMA)
    assert EXTRACTION_SCHEMA["properties"]["location"]["properties"]["city"]


def test_local_ai_extracts(ollama):
    a = LocalAIAnalyzer("qwen2.5:7b", ["Office Supplies"], company="Coastal Edge", url=ollama)
    ex = a.extract(parse_email(SAMPLES["receipt"], "work"))
    assert (ex.paid_status, ex.amount, ex.category, ex.currency) == ("paid", 84.5, "Office Supplies", "USD")
    req = FakeOllama.chats[0]
    assert req["model"] == "qwen2.5:7b" and req["format"] == EXTRACTION_SCHEMA and req["stream"] is False
    assert "Coastal Edge" in req["messages"][0]["content"]
    assert "Staples" in req["messages"][1]["content"]


def test_setup_downloads_model_once(ollama):
    cfg = Config(ai="local", ollama_url=ollama)
    out = []
    assert app.setup_local_ai(cfg, ask=lambda q: "y", out=out.append)
    assert FakeOllama.models == ["qwen2.5:7b"]
    assert any("100%" in line for line in out)
    assert app.setup_local_ai(cfg, ask=lambda q: "y", out=out.append)  # already there: no second download
    assert FakeOllama.models == ["qwen2.5:7b"]


def test_not_running_falls_back_without_installing(monkeypatch):
    cfg = Config(ai="local", ollama_url="http://127.0.0.1:9")
    out = []
    assert not app.setup_local_ai(cfg, ask=lambda q: "n", out=out.append)
    assert Ollama("http://127.0.0.1:9").running() is False
