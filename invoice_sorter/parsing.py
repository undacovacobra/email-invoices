"""Turn raw RFC 822 bytes into a RawEmail."""

from __future__ import annotations

import hashlib
import io
import re
from email import message_from_bytes, policy
from email.message import EmailMessage
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser

from .models import Attachment, RawEmail

KEEP_ATTACHMENT_TYPES = ("application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/html")


class _HTMLToText(HTMLParser):
    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "table", "td"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("style", "script", "head"):
            self._skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n" if tag != "td" else " ")

    def handle_endtag(self, tag):
        if tag in ("style", "script", "head") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    parser = _HTMLToText()
    parser.feed(html)
    text = "".join(parser.parts)
    text = re.sub(r"[ \t\xa0]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def pdf_to_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception:
        return ""


def _body_text(msg: EmailMessage) -> str:
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    try:
        content = part.get_content()
    except Exception:
        payload = part.get_payload(decode=True) or b""
        content = payload.decode("utf-8", errors="replace")
    if part.get_content_type() == "text/html":
        return html_to_text(content)
    return content.strip()


def parse_email(raw: bytes, account: str) -> RawEmail:
    msg = message_from_bytes(raw, policy=policy.default)

    date_iso = None
    if msg["Date"]:
        try:
            date_iso = parsedate_to_datetime(str(msg["Date"])).isoformat()
        except (TypeError, ValueError):
            pass

    message_id = str(msg["Message-ID"] or "").strip()
    if not message_id:
        message_id = "<sha1-" + hashlib.sha1(raw).hexdigest() + ">"

    attachments = []
    for part in msg.iter_attachments():
        ctype = part.get_content_type()
        if ctype not in KEEP_ATTACHMENT_TYPES:
            continue
        data = part.get_payload(decode=True) or b""
        attachments.append(Attachment(part.get_filename() or "attachment", ctype, data))

    return RawEmail(
        account=account,
        message_id=message_id,
        subject=str(msg["Subject"] or ""),
        from_addr=str(msg["From"] or ""),
        to_addr=str(msg["To"] or ""),
        date=date_iso,
        body_text=_body_text(msg),
        in_reply_to=str(msg["In-Reply-To"] or "").strip(),
        references=str(msg["References"] or "").strip(),
        attachments=attachments,
        raw=raw,
    )


def attachment_text(att: Attachment) -> str:
    if att.content_type == "application/pdf":
        return pdf_to_text(att.data)
    if att.content_type == "text/html":
        return html_to_text(att.data.decode("utf-8", errors="replace"))
    if att.content_type == "text/plain":
        return att.data.decode("utf-8", errors="replace")
    return ""


def full_text(email: RawEmail) -> str:
    """Body plus any readable attachment text (used by the keyword filter and offline mode)."""
    chunks = [email.body_text]
    for att in email.attachments:
        text = attachment_text(att)
        if text:
            chunks.append(f"--- attachment: {att.filename} ---\n{text}")
    return "\n\n".join(chunks)
