"""Read email from the connected accounts.

Every source yields raw RFC 822 bytes. Nothing is modified on the server:
IMAP folders are opened read-only and messages are fetched with BODY.PEEK,
so emails are not marked as read.
"""

from __future__ import annotations

import imaplib
import mailbox
import re
from datetime import date
from pathlib import Path
from typing import Callable, Iterator

from .config import AccountConfig

KnownCheck = Callable[[str], bool]


def iter_account(account: AccountConfig, is_known: KnownCheck) -> Iterator[bytes]:
    if account.type == "imap":
        yield from _iter_imap(account, is_known)
    elif account.type == "mbox":
        yield from _iter_mbox(account)
    elif account.type == "eml_folder":
        yield from _iter_eml_folder(account)
    else:
        raise ValueError(f"Account '{account.name}': unknown type '{account.type}' (use imap, mbox or eml_folder)")


def _iter_mbox(account: AccountConfig) -> Iterator[bytes]:
    if not account.path:
        raise ValueError(f"Account '{account.name}': mbox needs a path")
    box = mailbox.mbox(account.path, create=False)
    for key in box.iterkeys():
        yield box.get_bytes(key)


def _iter_eml_folder(account: AccountConfig) -> Iterator[bytes]:
    if not account.path:
        raise ValueError(f"Account '{account.name}': eml_folder needs a path")
    for p in sorted(Path(account.path).rglob("*.eml")):
        yield p.read_bytes()


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
