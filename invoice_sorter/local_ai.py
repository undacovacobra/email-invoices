"""Free AI that runs on this computer, through Ollama (https://ollama.com).

Nothing leaves the computer and there is no bill. It is slower and a little less
sharp than Claude, so the double-check and the review queue matter more.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from typing import Callable, Optional, Sequence

from pydantic import ValidationError

from .analyzers import AnalysisError, _clean, build_system_prompt, email_as_text
from .models import UNCATEGORIZED, Extraction, RawEmail, Verification

DEFAULT_URL = "http://localhost:11434"
# Talk to Ollama directly: a company proxy setting must never catch calls to this computer.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
DEFAULT_MODEL = "qwen2.5:7b"  # about 4.7 GB; good at pulling details out of text
LOCAL_BODY_CHARS = 8000       # small models get slow and vague on very long inputs


def _inline_refs(schema: dict) -> dict:
    """Ollama's structured output wants a plain schema, so expand $ref/$defs."""
    defs = schema.get("$defs", {})

    def walk(node):
        if isinstance(node, dict):
            if "$ref" in node:
                return walk(defs[node["$ref"].split("/")[-1]])
            return {k: walk(v) for k, v in node.items() if k != "$defs"}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(schema)


EXTRACTION_SCHEMA = _inline_refs(Extraction.model_json_schema())
VERIFICATION_SCHEMA = _inline_refs(Verification.model_json_schema())


class Ollama:
    """The few calls we need from Ollama's local web API."""

    def __init__(self, url: str = DEFAULT_URL, timeout: float = 600):
        self.url = url.rstrip("/")
        self.timeout = timeout

    def _post(self, path: str, body: dict, timeout: Optional[float] = None):
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        return _OPENER.open(req, timeout=timeout or self.timeout)

    def running(self) -> bool:
        try:
            with _OPENER.open(self.url + "/api/tags", timeout=3) as r:
                return r.status == 200
        except Exception:
            return False

    def models(self) -> list[str]:
        with _OPENER.open(self.url + "/api/tags", timeout=10) as r:
            return [m.get("name", "") for m in json.load(r).get("models", [])]

    def has_model(self, model: str) -> bool:
        names = self.models()
        return model in names or f"{model}:latest" in names

    def pull(self, model: str, on_progress: Callable[[str, float], None] = lambda s, f: None) -> None:
        with self._post("/api/pull", {"model": model, "stream": True}, timeout=24 * 3600) as r:
            for line in r:
                if not line.strip():
                    continue
                msg = json.loads(line)
                if msg.get("error"):
                    raise RuntimeError(msg["error"])
                total, done = msg.get("total"), msg.get("completed")
                on_progress(msg.get("status", ""), (done / total) if total and done else -1)

    def chat_json(self, model: str, system: str, user: str, schema: dict) -> str:
        body = {
            "model": model, "stream": False, "format": schema,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "options": {"temperature": 0, "num_ctx": 8192},
        }
        try:
            with self._post("/api/chat", body) as r:
                return json.load(r)["message"]["content"]
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            raise AnalysisError(f"The free AI returned an error: {detail}") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise AnalysisError("The free AI isn't running. Open the Ollama app and try again.") from e


def install_ollama(out=print) -> bool:
    """Install Ollama with winget (built into Windows 10/11). Returns True if it ends up running."""
    winget = shutil.which("winget")
    if not winget:
        out("I can't install it automatically on this computer.")
        out("Download it from https://ollama.com/download, install it, then come back here.")
        return False
    out("Installing Ollama (free). Windows may ask for permission - click Yes.")
    subprocess.run([winget, "install", "-e", "--id", "Ollama.Ollama",
                    "--accept-source-agreements", "--accept-package-agreements"], check=False)
    client = Ollama()
    for _ in range(60):  # the app starts itself after installing
        if client.running():
            return True
        time.sleep(2)
    out("Ollama is installed but not running yet. Open 'Ollama' from the Start menu, then try again.")
    return False


class LocalAIAnalyzer:
    name = "local-ai"

    def __init__(self, model: str, categories: Sequence[str], examples: Sequence[dict] = (),
                 company: Optional[str] = None, url: str = DEFAULT_URL, client: Optional[Ollama] = None):
        self.model = model
        self.categories = list(categories)
        self.system = build_system_prompt(company, categories, examples)
        self.client = client or Ollama(url)

    def _text(self, email: RawEmail) -> str:
        # Local models can't open PDFs, so attachment text is extracted and included.
        text = email_as_text(email, include_attachment_text=True)
        if len(text) > LOCAL_BODY_CHARS:
            text = text[:LOCAL_BODY_CHARS] + "\n[cut here to keep the free AI fast]"
        return text

    def extract(self, email: RawEmail) -> Extraction:
        raw = self.client.chat_json(
            self.model, self.system,
            "Analyse this email. Reply with JSON only.\n\n" + self._text(email), EXTRACTION_SCHEMA)
        try:
            ex = Extraction.model_validate_json(raw)
        except ValidationError as e:
            raise AnalysisError("The free AI's answer was incomplete.") from e
        return _clean(ex, self.categories)

    def verify(self, email: RawEmail, prior: dict, related: Sequence[tuple[int, RawEmail]]) -> Verification:
        related_text = "\n\n".join(
            f"=== Related email id={rid} ===\n{email_as_text(r, include_attachment_text=True)[:2500]}"
            for rid, r in related) or "(no related emails were found)"
        user = (
            "A first look at the email below was not confident. Double-check it.\n\n"
            f"First look:\n{json.dumps(prior, default=str)}\n\n=== Email being checked ===\n{self._text(email)[:4000]}\n\n"
            f"Related emails from the same mailbox:\n\n{related_text}\n\n"
            "Mark 'paid' only if this email or a related one clearly shows payment for THIS purchase. "
            "If it is still unclear, answer 'unclear' with low confidence so a person reviews it. "
            "Reply with JSON only."
        )
        raw = self.client.chat_json(self.model, self.system, user, VERIFICATION_SCHEMA)
        try:
            v = Verification.model_validate_json(raw)
        except ValidationError as e:
            raise AnalysisError("The free AI's answer was incomplete.") from e
        if v.category not in self.categories:
            v.category = UNCATEGORIZED
        v.confidence = max(0.0, min(1.0, v.confidence))
        return v
