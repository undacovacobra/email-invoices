"""Read a Microsoft 365 mailbox directly through Microsoft Graph.

Works with any Outlook (new, classic or web) because it talks to Microsoft's
servers, not the app. You sign in once with Microsoft's own sign-in page
(a short code you type at microsoft.com/devicelogin); after that the program
renews its access by itself. It asks only for permission to READ mail.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path
from typing import Callable, Iterator, Optional

from . import prefilter

LOGIN = "https://login.microsoftonline.com"
GRAPH = "https://graph.microsoft.com/v1.0"
SCOPES = "offline_access User.Read Mail.Read"


class SignInError(Exception):
    pass


def _post_form(url: str, fields: dict) -> dict:
    req = urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            raise SignInError(f"Microsoft sign-in failed ({e.code}).") from e


class MicrosoftAccount:
    """Holds the sign-in for one mailbox and keeps its access fresh."""

    def __init__(self, client_id: str, tenant: str, token_file: Path, login_url: str = LOGIN,
                 graph_url: str = GRAPH):
        self.client_id = client_id
        self.tenant = tenant or "organizations"
        self.token_file = Path(token_file)
        self.login_url = login_url.rstrip("/")
        self.graph_url = graph_url.rstrip("/")
        self.tokens: dict = {}
        if self.token_file.exists():
            try:
                self.tokens = json.loads(self.token_file.read_text(encoding="utf-8"))
            except Exception:
                self.tokens = {}

    @property
    def _token_url(self) -> str:
        return f"{self.login_url}/{self.tenant}/oauth2/v2.0/token"

    def _save(self, data: dict) -> None:
        data["expires_at"] = time.time() + int(data.get("expires_in", 3600)) - 120
        if "refresh_token" not in data and "refresh_token" in self.tokens:
            data["refresh_token"] = self.tokens["refresh_token"]
        self.tokens = data
        self.token_file.parent.mkdir(parents=True, exist_ok=True)
        self.token_file.write_text(json.dumps(data), encoding="utf-8")

    @property
    def signed_in(self) -> bool:
        return bool(self.tokens.get("refresh_token") or self.tokens.get("access_token"))

    def sign_in(self, out=print, open_browser: bool = True, sleep: Callable[[float], None] = time.sleep) -> None:
        start = _post_form(f"{self.login_url}/{self.tenant}/oauth2/v2.0/devicecode",
                           {"client_id": self.client_id, "scope": SCOPES})
        if "user_code" not in start:
            raise SignInError(_explain(start))
        url = start.get("verification_uri", "https://microsoft.com/devicelogin")
        out("")
        out("=" * 64)
        out(f"  Go to:        {url}")
        out(f"  Type the code: {start['user_code']}")
        out("  Then sign in with your work email and click Accept.")
        out("=" * 64)
        if open_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        interval = int(start.get("interval", 5))
        deadline = time.time() + int(start.get("expires_in", 900))
        while time.time() < deadline:
            sleep(interval)
            res = _post_form(self._token_url, {
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "client_id": self.client_id, "device_code": start["device_code"]})
            if "access_token" in res:
                self._save(res)
                return
            err = res.get("error")
            if err == "authorization_pending":
                continue
            if err == "slow_down":
                interval += 5
                continue
            raise SignInError(_explain(res))
        raise SignInError("The sign-in code expired. Try again and enter the code within 15 minutes.")

    def access_token(self) -> str:
        if self.tokens.get("access_token") and time.time() < self.tokens.get("expires_at", 0):
            return self.tokens["access_token"]
        if not self.tokens.get("refresh_token"):
            raise SignInError("Not signed in to Microsoft yet.")
        res = _post_form(self._token_url, {"grant_type": "refresh_token", "client_id": self.client_id,
                                           "refresh_token": self.tokens["refresh_token"], "scope": SCOPES})
        if "access_token" not in res:
            raise SignInError("Your Microsoft sign-in expired. Sign in again under Settings. " + _explain(res))
        self._save(res)
        return res["access_token"]

    def get(self, url: str, raw: bool = False):
        if not url.startswith("http"):
            url = self.graph_url + url
        for attempt in range(4):
            req = urllib.request.Request(url, headers={"Authorization": "Bearer " + self.access_token()})
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    return r.read() if raw else json.load(r)
            except urllib.error.HTTPError as e:
                if e.code in (429, 503, 504) and attempt < 3:  # Microsoft asks us to slow down
                    time.sleep(int(e.headers.get("Retry-After", "5")))
                    continue
                if e.code == 401 and attempt < 3:
                    self.tokens.pop("access_token", None)
                    continue
                raise SignInError(f"Microsoft refused the request ({e.code}): {e.read()[:200]!r}") from e
        raise SignInError("Microsoft kept asking to slow down. Try again in a few minutes.")

    def email_address(self) -> str:
        me = self.get("/me?$select=mail,userPrincipalName")
        return me.get("mail") or me.get("userPrincipalName") or "Microsoft 365"


def _explain(res: dict) -> str:
    desc = str(res.get("error_description", res.get("error", "unknown error")))
    code = desc.split(":")[0]
    hints = {
        "AADSTS7000218": "In the app registration, open Authentication and set 'Allow public client flows' to Yes.",
        "AADSTS65001": "Permission wasn't granted. Click Accept on the sign-in page (an admin may need to approve).",
        "AADSTS700016": "The Application (client) ID wasn't found. Copy it again from the app registration.",
        "AADSTS90002": "The Directory (tenant) ID wasn't found. Copy it again from the app registration.",
        "AADSTS70000": "Sign-in was declined.",
    }
    return hints.get(code, desc.splitlines()[0][:300])


def iter_mailbox(acct: MicrosoftAccount, since: Optional[str], is_known: Callable[[str], bool],
                 log=print) -> Iterator[bytes]:
    """Yield the full email (with attachments) for every message that looks purchase-related."""
    params = {
        "$select": "id,subject,bodyPreview,hasAttachments,internetMessageId,receivedDateTime",
        "$top": "100", "$orderby": "receivedDateTime desc",
    }
    if since:
        params["$filter"] = f"receivedDateTime ge {since}T00:00:00Z"
    url: Optional[str] = "/me/messages?" + urllib.parse.urlencode(params)
    seen = 0
    while url:
        page = acct.get(url)
        for m in page.get("value", []):
            seen += 1
            mid = (m.get("internetMessageId") or "").strip()
            if mid and is_known(mid):
                continue
            hint = ["attachment.pdf"] if m.get("hasAttachments") else []
            # The preview is short, so keep anything with even one money word; the full check comes later.
            if prefilter.score(m.get("subject") or "", m.get("bodyPreview") or "", hint) < 1:
                continue
            yield acct.get(f"/me/messages/{urllib.parse.quote(m['id'], safe='')}/$value", raw=True)
        url = page.get("@odata.nextLink")
        if seen and seen % 1000 == 0:
            log(f"  looked through {seen} emails so far...")
