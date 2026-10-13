"""Read email from the connected accounts.

Every source yields raw RFC 822 bytes. Nothing is modified on the server:
IMAP folders are opened read-only and messages are fetched with BODY.PEEK,
so emails are not marked as read.
"""

from __future__ import annotations

import imaplib
import mailbox
import mimetypes
import re
import tempfile
from datetime import date, datetime
from email.message import EmailMessage
from email.utils import format_datetime
from pathlib import Path
from typing import Callable, Iterable, Iterator, Optional

from . import prefilter
from .config import AccountConfig
from .parsing import html_to_text

KnownCheck = Callable[[str], bool]


def iter_account(account: AccountConfig, is_known: KnownCheck) -> Iterator[bytes]:
    if account.type == "outlook_app":
        yield from _iter_outlook_app(account, is_known)
    elif account.type == "imap":
        yield from _iter_imap(account, is_known)
    elif account.type == "mbox":
        yield from _iter_mbox(account)
    elif account.type == "eml_folder":
        yield from _iter_eml_folder(account)
    else:
        raise ValueError(f"Account '{account.name}': unknown type '{account.type}' "
                         "(use outlook_app, imap, mbox or eml_folder)")


def _iter_mbox(account: AccountConfig) -> Iterator[bytes]:
    if not account.path:
        raise ValueError(f"Account '{account.name}': mbox needs a path")
    box = mailbox.mbox(account.path, create=False)
    for key in box.iterkeys():
        yield box.get_bytes(key)


def _iter_eml_folder(account: AccountConfig) -> Iterator[bytes]:
    if not account.path:
        raise ValueError(f"Account '{account.name}': eml_folder needs a path")
    for p in sorted(Path(account.path).rglob("*")):
        suffix = p.suffix.lower()
        if suffix == ".eml":
            yield p.read_bytes()
        elif suffix == ".msg":
            try:
                yield _msg_file_to_bytes(p)
            except Exception as e:  # a damaged file shouldn't stop the whole scan
                print(f"  ! Could not read {p.name}: {e}")


def build_mime(*, subject: str, sender: str, to: str, date_value: Optional[datetime], message_id: str,
               body: str = "", html: str = "", in_reply_to: str = "", references: str = "",
               attachments: Iterable[tuple[str, bytes]] = ()) -> bytes:
    """Turn an email read from Outlook into standard bytes the rest of the program understands."""
    msg = EmailMessage()
    msg["Subject"] = (subject or "").replace("\r", " ").replace("\n", " ")
    msg["From"] = sender or ""
    msg["To"] = (to or "").replace("\r", " ").replace("\n", " ")
    if date_value is not None:
        if date_value.tzinfo is None:
            date_value = date_value.astimezone()
        msg["Date"] = format_datetime(date_value)
    msg["Message-ID"] = message_id
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if references:
        msg["References"] = " ".join(references.split())
    msg.set_content(body or (html_to_text(html) if html else ""))
    if html:
        msg.add_alternative(html, subtype="html")
    for filename, data in attachments:
        ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        maintype, subtype = ctype.split("/", 1)
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
    return bytes(msg)


def _msg_file_to_bytes(path: Path) -> bytes:
    """Outlook's own .msg format (what you get dragging an email out of Outlook for Windows)."""
    import extract_msg

    m = extract_msg.Message(str(path))
    try:
        header = getattr(m, "header", None)
        get = (lambda k: (header.get(k) or "").strip()) if header is not None else (lambda k: "")
        html = m.htmlBody or b""
        if isinstance(html, bytes):
            html = html.decode("utf-8", errors="replace")
        attachments = []
        for att in m.attachments:
            data = getattr(att, "data", None)
            if isinstance(data, bytes):
                attachments.append((att.longFilename or att.shortFilename or "attachment", data))
        date_value = m.date if isinstance(m.date, datetime) else None
        return build_mime(
            subject=m.subject or "", sender=m.sender or "", to=m.to or "", date_value=date_value,
            message_id=(m.messageId or get("Message-ID") or f"<msgfile-{path.stem}@local>").strip(),
            body=m.body or "", html=html, in_reply_to=get("In-Reply-To"), references=get("References"),
            attachments=attachments,
        )
    finally:
        m.close()


# --- Outlook desktop app (Windows) -------------------------------------------------

PR_INTERNET_MESSAGE_ID = "http://schemas.microsoft.com/mapi/proptag/0x1035001F"
PR_IN_REPLY_TO_ID = "http://schemas.microsoft.com/mapi/proptag/0x1042001F"
PR_INTERNET_REFERENCES = "http://schemas.microsoft.com/mapi/proptag/0x1039001F"
OL_MAIL_ITEM = 43
SKIP_FOLDERS = {"deleted items", "junk email", "junk e-mail", "drafts", "outbox", "conversation history",
                "rss feeds", "sync issues", "calendar", "contacts", "tasks", "notes", "journal"}


def outlook_mailboxes() -> list[str]:
    """Names of the mailboxes in the Outlook app on this computer ([] if Outlook isn't available)."""
    try:
        ns = _outlook_namespace()
        return [store.DisplayName for store in ns.Stores]
    except Exception:
        return []


def outlook_mailboxes_waiting(timeout: float = 90) -> Optional[list[str]]:
    """Like outlook_mailboxes, but gives up after `timeout` seconds (None) instead of hanging.

    Outlook can block while it starts, waits for a sign-in, or shows its
    "allow access?" prompt behind other windows.
    """
    import threading

    result: list = []

    def work() -> None:
        try:
            import pythoncom  # COM needs setting up on each thread that uses it

            pythoncom.CoInitialize()
        except Exception:
            pass
        result.append(outlook_mailboxes())

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(timeout)
    return result[0] if result else None


def _outlook_namespace():
    import win32com.client  # from pywin32; only on Windows

    return win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")


def _prop(item, tag: str) -> str:
    try:
        return str(item.PropertyAccessor.GetProperty(tag) or "").strip()
    except Exception:
        return ""


def _walk(folder, wanted: set[str]) -> Iterator:
    name = str(folder.Name).lower()
    if name in SKIP_FOLDERS:
        return
    if not wanted or name in wanted:
        yield folder
        wanted_below: set[str] = set()  # take every subfolder of a chosen folder
    else:
        wanted_below = wanted
    for sub in folder.Folders:
        yield from _walk(sub, wanted_below)


def _attachment_names(item) -> list[str]:
    names = []
    for i in range(1, item.Attachments.Count + 1):
        try:
            names.append(str(item.Attachments.Item(i).FileName))
        except Exception:
            pass
    return names


def outlook_item_to_bytes(item, with_attachments: bool = True) -> bytes:
    attachments = []
    if with_attachments:
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(1, item.Attachments.Count + 1):
                att = item.Attachments.Item(i)
                try:
                    name = str(att.FileName)
                except Exception:
                    continue  # embedded items without a file name
                target = Path(tmp) / f"{i}_{re.sub(r'[^A-Za-z0-9._-]', '_', name)}"
                try:
                    att.SaveAsFile(str(target))
                    attachments.append((name, target.read_bytes()))
                except Exception:
                    continue
    received = item.ReceivedTime
    date_value = datetime(received.year, received.month, received.day, received.hour, received.minute,
                          received.second) if received else None
    sender = item.SenderEmailAddress or ""
    if getattr(item, "SenderName", "") and "@" in sender:
        sender = f"{item.SenderName} <{sender}>"
    elif getattr(item, "SenderName", ""):
        sender = str(item.SenderName)
    return build_mime(
        subject=item.Subject or "", sender=sender, to=item.To or "", date_value=date_value,
        message_id=_prop(item, PR_INTERNET_MESSAGE_ID) or f"<outlook-{item.EntryID}@local>",
        body=item.Body or "", html=item.HTMLBody or "", in_reply_to=_prop(item, PR_IN_REPLY_TO_ID),
        references=_prop(item, PR_INTERNET_REFERENCES), attachments=attachments,
    )


def _iter_outlook_app(account: AccountConfig, is_known: KnownCheck) -> Iterator[bytes]:
    ns = _outlook_namespace()
    since = datetime.fromisoformat(account.since) if account.since else None
    wanted = {f.lower() for f in account.folders if f.upper() != "INBOX"} | (
        {"inbox"} if any(f.upper() == "INBOX" for f in account.folders) else set())
    for store in ns.Stores:
        if account.mailbox and str(store.DisplayName).lower() != account.mailbox.lower():
            continue
        for folder in _walk(store.GetRootFolder(), wanted):
            try:
                items = folder.Items
                if since:
                    items = items.Restrict("[ReceivedTime] >= '" + since.strftime("%m/%d/%Y %I:%M %p") + "'")
            except Exception:
                continue
            for item in items:
                try:
                    if item.Class != OL_MAIL_ITEM:
                        continue
                    if is_known(_prop(item, PR_INTERNET_MESSAGE_ID) or f"<outlook-{item.EntryID}@local>"):
                        continue
                    names = _attachment_names(item)
                    # Skip newsletters etc. before copying attachments out of Outlook.
                    if prefilter.score(item.Subject or "", item.Body or "", names) < prefilter.MIN_SCORE:
                        continue
                    yield outlook_item_to_bytes(item)
                except Exception as e:
                    print(f"  ! Skipped one email in {folder.Name}: {e}")


def _imap_date(iso: str) -> str:
    d = date.fromisoformat(iso)
    return d.strftime("%d-%b-%Y")


def _quote_folder(name: str) -> str:
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


_MSGID_RE = re.compile(rb"Message-ID:\s*(<[^>]+>)", re.IGNORECASE)


def _iter_imap(account: AccountConfig, is_known: KnownCheck) -> Iterator[bytes]:
    if not account.host or not account.username:
        raise ValueError(f"Account '{account.name}': imap needs host and username")
    conn = imaplib.IMAP4_SSL(account.host, account.port)
    try:
        conn.login(account.username, account.password())
        for folder in account.folders:
            status, _ = conn.select(_quote_folder(folder), readonly=True)
            if status != "OK":
                print(f"  ! {account.name}: could not open folder {folder!r}, skipping")
                continue
            uids: set[bytes] = set()
            since = f"SINCE {_imap_date(account.since)} " if account.since else ""
            # Ask the server to narrow things down so we don't download every email.
            for word in account.search_keywords:
                status, data = conn.uid("SEARCH", None, f'{since}TEXT "{word}"')
                if status == "OK" and data and data[0]:
                    uids.update(data[0].split())
            for uid in sorted(uids, key=int):
                # Cheap header fetch first so already-imported mail isn't downloaded again.
                status, data = conn.uid("FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
                if status == "OK" and data and isinstance(data[0], tuple):
                    m = _MSGID_RE.search(data[0][1])
                    if m and is_known(m.group(1).decode(errors="replace")):
                        continue
                status, data = conn.uid("FETCH", uid, "(BODY.PEEK[])")
                if status == "OK" and data and isinstance(data[0], tuple):
                    yield data[0][1]
    finally:
        try:
            conn.logout()
        except Exception:
            pass
