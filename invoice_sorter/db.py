"""SQLite storage: one row per email, one record per analysed email."""

from __future__ import annotations

import json
import sqlite3
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from .models import Attachment, Extraction, RawEmail
from .parsing import parse_email

SCHEMA = """
CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY,
    account TEXT NOT NULL,
    message_id TEXT NOT NULL,
    subject TEXT, from_addr TEXT, to_addr TEXT, date TEXT,
    in_reply_to TEXT, refs TEXT,
    body_text TEXT,
    attachment_names TEXT,
    raw BLOB,
    prefilter_score INTEGER,
    analysed INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account, message_id)
);
CREATE TABLE IF NOT EXISTS records (
    email_id INTEGER PRIMARY KEY REFERENCES emails(id),
    doc_type TEXT, paid_status TEXT, paid_evidence TEXT,
    vendor TEXT, amount REAL, currency TEXT, purchase_date TEXT, invoice_number TEXT,
    city TEXT, region TEXT, country TEXT, address TEXT,
    purpose TEXT, category TEXT, confidence REAL, notes TEXT,
    status TEXT NOT NULL,
    verify_note TEXT,
    linked_email_ids TEXT,
    duplicate_of INTEGER,
    analysed_by TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY,
    email_id INTEGER NOT NULL,
    field TEXT NOT NULL, old_value TEXT, new_value TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS extra_categories (name TEXT PRIMARY KEY);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    def __init__(self, path: str | Path):
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    # ---- emails -------------------------------------------------------
    def has_email(self, account: str, message_id: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM emails WHERE account=? AND message_id=?", (account, message_id)
        ).fetchone()
        return row is not None

    def add_email(self, email: RawEmail, prefilter_score: int) -> Optional[int]:
        cur = self.conn.execute(
            """INSERT OR IGNORE INTO emails
               (account, message_id, subject, from_addr, to_addr, date, in_reply_to, refs,
                body_text, attachment_names, raw, prefilter_score)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                email.account, email.message_id, email.subject, email.from_addr, email.to_addr,
                email.date, email.in_reply_to, email.references, email.body_text,
                json.dumps([a.filename for a in email.attachments]),
                zlib.compress(email.raw), prefilter_score,
            ),
        )
        self.conn.commit()
        return cur.lastrowid if cur.rowcount else None

    def email_row(self, email_id: int) -> sqlite3.Row:
        return self.conn.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchone()

    def load_email(self, email_id: int) -> RawEmail:
        row = self.email_row(email_id)
        return parse_email(zlib.decompress(row["raw"]), row["account"])

    def emails_to_analyse(self, min_score: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM emails WHERE analysed=0 AND prefilter_score>=? ORDER BY date", (min_score,)
        ).fetchall()

    def mark_analysed(self, email_id: int) -> None:
        self.conn.execute("UPDATE emails SET analysed=1 WHERE id=?", (email_id,))
        self.conn.commit()

    def find_emails_by_message_ids(self, ids: Iterable[str]) -> list[sqlite3.Row]:
        ids = [i for i in ids if i]
        if not ids:
            return []
        marks = ",".join("?" * len(ids))
        return self.conn.execute(f"SELECT * FROM emails WHERE message_id IN ({marks})", ids).fetchall()

    def emails_referencing(self, message_id: str) -> list[sqlite3.Row]:
        like = f"%{message_id}%"
        return self.conn.execute(
            "SELECT * FROM emails WHERE in_reply_to=? OR refs LIKE ?", (message_id, like)
        ).fetchall()

    # ---- records ------------------------------------------------------
    def save_extraction(self, email_id: int, ex: Extraction, status: str, analysed_by: str) -> None:
        loc = ex.location
        self.conn.execute(
            """INSERT OR REPLACE INTO records
               (email_id, doc_type, paid_status, paid_evidence, vendor, amount, currency,
                purchase_date, invoice_number, city, region, country, address, purpose,
                category, confidence, notes, status, verify_note, linked_email_ids,
                duplicate_of, analysed_by, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'[]',NULL,?,?)""",
            (
                email_id, ex.doc_type, ex.paid_status, ex.paid_evidence, ex.vendor, ex.amount,
                ex.currency, ex.purchase_date, ex.invoice_number, loc.city, loc.region,
                loc.country, loc.address, ex.purpose, ex.category, ex.confidence, ex.notes,
                status, analysed_by, now(),
            ),
        )
        self.conn.commit()

    def update_record(self, email_id: int, **fields: Any) -> None:
        if not fields:
            return
        fields["updated_at"] = now()
        if "linked_email_ids" in fields and not isinstance(fields["linked_email_ids"], str):
            fields["linked_email_ids"] = json.dumps(sorted(set(fields["linked_email_ids"])))
        cols = ", ".join(f"{k}=?" for k in fields)
        self.conn.execute(f"UPDATE records SET {cols} WHERE email_id=?", (*fields.values(), email_id))
        self.conn.commit()

    def record(self, email_id: int) -> Optional[sqlite3.Row]:
        return self.conn.execute(
            """SELECT r.*, e.account, e.subject, e.from_addr, e.date AS email_date, e.message_id,
                      e.in_reply_to, e.refs, e.body_text, e.attachment_names
               FROM records r JOIN emails e ON e.id = r.email_id WHERE r.email_id=?""",
            (email_id,),
        ).fetchone()

    def records(self, statuses: Optional[Iterable[str]] = None) -> list[sqlite3.Row]:
        sql = """SELECT r.*, e.account, e.subject, e.from_addr, e.date AS email_date, e.message_id,
                        e.in_reply_to, e.refs, e.body_text, e.attachment_names
                 FROM records r JOIN emails e ON e.id = r.email_id"""
        params: list[Any] = []
        if statuses is not None:
            statuses = list(statuses)
            sql += f" WHERE r.status IN ({','.join('?' * len(statuses))})"
            params = statuses
        sql += " ORDER BY COALESCE(r.purchase_date, e.date)"
        return self.conn.execute(sql, params).fetchall()

    # ---- corrections & learned categories ----------------------------
    def add_correction(self, email_id: int, field: str, old: Any, new: Any) -> None:
        self.conn.execute(
            "INSERT INTO corrections (email_id, field, old_value, new_value, created_at) VALUES (?,?,?,?,?)",
            (email_id, field, None if old is None else str(old), None if new is None else str(new), now()),
        )
        self.conn.commit()

    def reviewed_examples(self, limit: int = 15) -> list[sqlite3.Row]:
        """Emails you reviewed by hand, newest first: used to teach the AI your preferences."""
        return self.conn.execute(
            """SELECT r.*, e.subject, e.from_addr FROM records r JOIN emails e ON e.id=r.email_id
               WHERE r.email_id IN (SELECT DISTINCT email_id FROM corrections)
               ORDER BY r.updated_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()

    def extra_categories(self) -> list[str]:
        return [r[0] for r in self.conn.execute("SELECT name FROM extra_categories ORDER BY name")]

    def add_category(self, name: str) -> None:
        self.conn.execute("INSERT OR IGNORE INTO extra_categories (name) VALUES (?)", (name,))
        self.conn.commit()

    def stats(self) -> dict[str, int]:
        out = {"emails": self.conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0]}
        for row in self.conn.execute("SELECT status, COUNT(*) FROM records GROUP BY status"):
            out[row[0]] = row[1]
        return out


def attachments_of(row: sqlite3.Row) -> list[str]:
    try:
        return json.loads(row["attachment_names"] or "[]")
    except json.JSONDecodeError:
        return []


__all__ = ["Database", "Attachment", "attachments_of"]
