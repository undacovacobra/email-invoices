"""Verification: settle uncertain records and avoid double counting.

Two steps, both automatic:

1. Cross-checking (no AI needed). Emails about the same purchase are linked:
   same thread, same invoice/order number, or same vendor + same amount within
   a few months. When a quote or unpaid invoice has a matching payment, the quote
   is marked as a duplicate of the payment, and any details the payment email is
   missing (amount, vendor, what it was for, place) are filled in from it. When
   several "paid" emails describe one purchase (invoice + receipt + "thanks, got
   it"), only the most complete one is counted.

2. Second opinion. Anything still uncertain is re-checked by the analyser with
   the related emails attached and stricter instructions. If that is still not
   confident, the record goes to your review queue (`invoice-sorter review`).
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import date
from typing import Optional

from .analyzers import AnalysisError, Analyzer
from .db import Database
from .models import (
    COUNTED_STATUSES, DUPLICATE, EXCLUDED, NEEDS_REVIEW, PENDING_VERIFY, UNCATEGORIZED,
    USER_CONFIRMED, VERIFIED,
)

MATCH_WINDOW_DAYS = 120
MAX_RELATED = 5
BACKFILL_FIELDS = ("vendor", "amount", "currency", "invoice_number", "purpose", "project", "city", "region", "country",
                   "address")
_SUFFIXES = {"inc", "llc", "ltd", "co", "corp", "company", "the", "gmbh", "plc", "limited"}


def norm_invoice(v: Optional[str]) -> Optional[str]:
    if not v:
        return None
    s = re.sub(r"[^A-Z0-9]", "", v.upper()).lstrip("0")
    return s if len(s) >= 3 else None


def norm_vendor(v: Optional[str]) -> Optional[str]:
    if not v:
        return None
    tokens = [t for t in re.split(r"[^a-z0-9]+", v.lower()) if t and t not in _SUFFIXES]
    return tokens[0] if tokens else None


def _day(row: sqlite3.Row) -> Optional[date]:
    for key in ("purchase_date", "email_date"):
        v = row[key]
        if v:
            try:
                return date.fromisoformat(v[:10])
            except ValueError:
                continue
    return None


def _thread_ids(row: sqlite3.Row) -> set[str]:
    ids = set(re.findall(r"<[^>]+>", f"{row['in_reply_to'] or ''} {row['refs'] or ''}"))
    ids.add(row["message_id"])
    return ids


def is_related(a: sqlite3.Row, b: sqlite3.Row) -> Optional[str]:
    """Return why two records look like the same purchase, or None."""
    if a["email_id"] == b["email_id"]:
        return None
    if a["account"] == b["account"] and (_thread_ids(a) & _thread_ids(b)):
        amounts = (a["amount"], b["amount"])
        if None in amounts or abs(amounts[0] - amounts[1]) < 0.01 or a["invoice_number"] == b["invoice_number"]:
            return "same email thread"
    ia, ib = norm_invoice(a["invoice_number"]), norm_invoice(b["invoice_number"])
    if ia and ia == ib:
        va, vb = norm_vendor(a["vendor"]), norm_vendor(b["vendor"])
        if not va or not vb or va == vb:
            return f"same invoice/order number {a['invoice_number']}"
    if a["amount"] is not None and b["amount"] is not None and abs(a["amount"] - b["amount"]) < 0.01:
        va, vb = norm_vendor(a["vendor"]), norm_vendor(b["vendor"])
        da, dbb = _day(a), _day(b)
        if va and va == vb and da and dbb and abs((da - dbb).days) <= MATCH_WINDOW_DAYS:
            return f"same vendor and amount ({a['amount']:.2f})"
    return None


def _completeness(row: sqlite3.Row) -> tuple:
    filled = sum(row[f] is not None and row[f] != "" for f in BACKFILL_FIELDS + ("purchase_date",))
    return (row["status"] == USER_CONFIRMED, row["doc_type"] in ("receipt", "paid_invoice"), filled, row["confidence"] or 0)


def _note(old: Optional[str], new: str) -> str:
    return new if not old else (old if new in old else f"{old} | {new}")


def link_and_dedupe(db: Database) -> dict[str, int]:
    """Cross-check records against each other. Returns counts of what changed."""
    counts = {"quotes_matched_to_payment": 0, "duplicates_merged": 0}
    live = [r for r in db.records() if r["status"] != DUPLICATE]
    paid = [r for r in live if r["paid_status"] == "paid"]
    others = [r for r in live if r["paid_status"] != "paid" and r["status"] != USER_CONFIRMED]

    # Quotes / unpaid invoices that were paid later: link them to the payment.
    for p in paid:
        for o in others:
            why = is_related(p, o)
            if not why or o["doc_type"] not in ("quote_or_estimate", "unpaid_invoice", "paid_invoice", "order_confirmation"):
                continue
            fill = {f: o[f] for f in BACKFILL_FIELDS if (p[f] is None or p[f] == "") and o[f] not in (None, "")}
            if p["category"] == UNCATEGORIZED and o["category"] and o["category"] != UNCATEGORIZED:
                fill["category"] = o["category"]
            linked = set(json.loads(p["linked_email_ids"] or "[]")) | {o["email_id"]}
            note = f"Matched to email #{o['email_id']} ({why})"
            if fill:
                note += "; filled " + ", ".join(sorted(fill)) + " from it"
            db.update_record(p["email_id"], linked_email_ids=linked, verify_note=_note(p["verify_note"], note), **fill)
            db.update_record(
                o["email_id"], status=DUPLICATE, duplicate_of=p["email_id"],
                verify_note=_note(o["verify_note"], f"Paid - see email #{p['email_id']} ({why})"),
            )
            counts["quotes_matched_to_payment"] += 1
            p = db.record(p["email_id"])

    # Several "paid" emails about one purchase: count it once.
    paid = [db.record(r["email_id"]) for r in paid]
    paid = [r for r in paid if r["status"] != DUPLICATE]
    done: set[int] = set()
    for i, a in enumerate(paid):
        if a["email_id"] in done:
            continue
        group = [a]
        for b in paid[i + 1:]:
            if b["email_id"] not in done and any(is_related(g, b) for g in group):
                group.append(b)
        if len(group) < 2:
            continue
        keep = max(group, key=_completeness)
        fill: dict = {}
        for g in group:
            done.add(g["email_id"])
            if g is keep:
                continue
            for f in BACKFILL_FIELDS:
                if (keep[f] is None or keep[f] == "") and g[f] not in (None, "") and f not in fill:
                    fill[f] = g[f]
            if g["status"] != USER_CONFIRMED:
                db.update_record(
                    g["email_id"], status=DUPLICATE, duplicate_of=keep["email_id"],
                    verify_note=_note(g["verify_note"], f"Same purchase as email #{keep['email_id']}"),
                )
                counts["duplicates_merged"] += 1
        linked = set(json.loads(keep["linked_email_ids"] or "[]")) | {g["email_id"] for g in group if g is not keep}
        db.update_record(keep["email_id"], linked_email_ids=linked, **fill)
    return counts


def release_duplicates(db: Database, email_id: int, reason: str) -> int:
    """Records hidden as duplicates of `email_id` come back for review (e.g. it turned out not to be paid)."""
    rows = db.conn.execute("SELECT email_id, verify_note FROM records WHERE duplicate_of=?", (email_id,)).fetchall()
    for r in rows:
        db.update_record(r["email_id"], status=NEEDS_REVIEW, duplicate_of=None,
                         verify_note=_note(r["verify_note"], reason))
    return len(rows)


def related_emails(db: Database, rec: sqlite3.Row) -> list[int]:
    """Email ids worth showing alongside `rec`: thread members and matching records."""
    ids: list[int] = []
    thread = _thread_ids(rec)
    for row in db.find_emails_by_message_ids(thread) + db.emails_referencing(rec["message_id"]):
        if row["id"] != rec["email_id"] and row["account"] == rec["account"] and row["id"] not in ids:
            ids.append(row["id"])
    for other in db.records():
        if other["email_id"] not in ids and is_related(rec, other):
            ids.append(other["email_id"])
    for i in json.loads(rec["linked_email_ids"] or "[]"):
        if i not in ids and i != rec["email_id"]:
            ids.append(i)
    return ids[:MAX_RELATED]


def prior_summary(rec: sqlite3.Row) -> dict:
    keys = ("doc_type", "paid_status", "paid_evidence", "vendor", "amount", "currency", "purchase_date",
            "invoice_number", "city", "region", "country", "purpose", "project", "category", "confidence", "notes", "verify_note")
    return {k: rec[k] for k in keys}


def verify_pending(db: Database, analyzer: Analyzer, threshold: float, log=print) -> dict[str, int]:
    counts = {VERIFIED: 0, EXCLUDED: 0, NEEDS_REVIEW: 0}
    for rec in db.records([PENDING_VERIFY]):
        rel_ids = related_emails(db, rec)
        try:
            v = analyzer.verify(db.load_email(rec["email_id"]), prior_summary(rec),
                                [(i, db.load_email(i)) for i in rel_ids])
        except AnalysisError as e:
            db.update_record(rec["email_id"], status=NEEDS_REVIEW, verify_note=_note(rec["verify_note"], str(e)))
            counts[NEEDS_REVIEW] += 1
            continue

        fields: dict = {"paid_status": v.paid_status, "confidence": v.confidence}
        if v.category and (v.category != UNCATEGORIZED or rec["category"] == UNCATEGORIZED):
            fields["category"] = v.category
        for f in ("amount", "purchase_date", "vendor", "purpose", "project"):
            if getattr(v, f) not in (None, ""):
                fields[f] = getattr(v, f)
        category = fields.get("category", rec["category"])
        settled = v.confidence >= threshold and v.paid_status != "unclear"
        if settled and v.paid_status == "not_paid":
            status = EXCLUDED
        elif settled and category != UNCATEGORIZED:
            status = VERIFIED
        else:
            status = NEEDS_REVIEW
        linked = set(json.loads(rec["linked_email_ids"] or "[]")) | {i for i in v.supporting_email_ids if i in rel_ids}
        db.update_record(rec["email_id"], status=status, linked_email_ids=linked,
                         verify_note=_note(rec["verify_note"], f"Double-check: {v.reasoning}"), **fields)
        counts[status] += 1
        log(f"    #{rec['email_id']} {rec['subject'][:60]!r}: {status.replace('_', ' ')}")
    return counts


__all__ = ["link_and_dedupe", "verify_pending", "related_emails", "is_related", "COUNTED_STATUSES"]
