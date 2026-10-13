"""scan = fetch new mail -> keyword filter -> analyse -> cross-check -> double-check uncertain ones."""

from __future__ import annotations

from typing import Optional

from . import prefilter
from .analyzers import AnalysisError, Analyzer
from .config import Config
from .db import Database
from .models import (
    CONFIRMED, EXCLUDED, NEEDS_REVIEW, PENDING_VERIFY, UNCATEGORIZED, Extraction, Location,
)
from .parsing import full_text, parse_email
from .sources import iter_account
from .verify import link_and_dedupe, verify_pending


def all_categories(cfg: Config, db: Database) -> list[str]:
    cats = list(cfg.categories)
    cats += [c for c in db.extra_categories() if c not in cats]
    return cats


def initial_status(ex: Extraction, threshold: float) -> str:
    if ex.confidence >= threshold:
        if ex.paid_status == "not_paid":
            return EXCLUDED
        if ex.paid_status == "paid" and ex.category != UNCATEGORIZED:
            return CONFIRMED
    if ex.doc_type == "not_a_purchase" and ex.paid_status != "paid" and ex.confidence >= 0.6:
        return EXCLUDED
    return PENDING_VERIFY


def fetch(cfg: Config, db: Database, only: Optional[list[str]] = None, log=print) -> int:
    new = 0
    for account in cfg.accounts:
        if only and account.name not in only:
            continue
        log(f"Reading {account.name} ({account.type})...")
        count = 0
        for raw in iter_account(account, lambda mid, a=account.name: db.has_email(a, mid)):
            email = parse_email(raw, account.name)
            if db.has_email(account.name, email.message_id):
                continue
            s = prefilter.score(email.subject, full_text(email), [a.filename for a in email.attachments])
            if db.add_email(email, s):
                count += 1
        log(f"  {count} new email(s)")
        new += count
    return new


def analyse(cfg: Config, db: Database, analyzer: Analyzer, include_all: bool = False, log=print) -> int:
    rows = db.emails_to_analyse(0 if include_all else prefilter.MIN_SCORE)
    if rows:
        log(f"Analysing {len(rows)} email(s) that look purchase-related...")
    for row in rows:
        email = db.load_email(row["id"])
        try:
            ex = analyzer.extract(email)
            status = initial_status(ex, cfg.confidence_threshold)
        except AnalysisError as e:
            ex = Extraction(
                doc_type="not_a_purchase", paid_status="unclear", paid_evidence="", vendor=None, amount=None,
                currency=None, purchase_date=(email.date or "")[:10] or None, invoice_number=None,
                location=Location(city=None, region=None, country=None, address=None), purpose=email.subject,
                category=UNCATEGORIZED, confidence=0.0, notes=str(e),
            )
            status = NEEDS_REVIEW
        db.save_extraction(row["id"], ex, status, analyzer.name)
        db.mark_analysed(row["id"])
        amount = f"{ex.amount:,.2f} {ex.currency or ''}".strip() if ex.amount is not None else "-"
        log(f"  #{row['id']} {email.subject[:55]!r}: {ex.paid_status}, {amount}, {ex.category} -> {status.replace('_', ' ')}")
    return len(rows)


def scan(cfg: Config, db: Database, analyzer: Analyzer, only=None, include_all=False, fetch_mail=True, log=print) -> dict:
    if fetch_mail:
        fetch(cfg, db, only, log)
    analyse(cfg, db, analyzer, include_all, log)
    linked = link_and_dedupe(db)
    pending = len(db.records([PENDING_VERIFY]))
    if pending:
        log(f"Double-checking {pending} uncertain item(s) against related emails...")
    verified = verify_pending(db, analyzer, cfg.confidence_threshold, log)
    linked2 = link_and_dedupe(db)
    return {
        "quotes_matched_to_payment": linked["quotes_matched_to_payment"] + linked2["quotes_matched_to_payment"],
        "duplicates_merged": linked["duplicates_merged"] + linked2["duplicates_merged"],
        **{f"double_check_{k}": v for k, v in verified.items()},
        **db.stats(),
    }
