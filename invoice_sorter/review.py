"""Walk through the items the system could not settle on its own.

Every answer is saved as a correction. Corrections override the AI and are fed
back into future scans as examples, so similar emails get handled your way.
"""

from __future__ import annotations

import textwrap
from typing import Callable, Optional, Sequence

from .db import Database, attachments_of
from .models import EXCLUDED, NEEDS_REVIEW, UNCATEGORIZED, USER_CONFIRMED
from .verify import link_and_dedupe, release_duplicates

Ask = Callable[[str], str]


def _fmt_amount(rec) -> str:
    return f"{rec['amount']:,.2f} {rec['currency'] or ''}".strip() if rec["amount"] is not None else "unknown amount"


def _place(rec) -> str:
    return ", ".join(p for p in (rec["city"], rec["region"], rec["country"]) if p) or ""


def show(rec, out=print, excerpt_chars: int = 1200) -> None:
    out("=" * 72)
    out(f"Email #{rec['email_id']}  [{rec['account']}]  {rec['email_date'] or ''}")
    out(f"From:    {rec['from_addr']}")
    out(f"Subject: {rec['subject']}")
    atts = attachments_of(rec)
    if atts:
        out(f"Attachments: {', '.join(atts)}")
    out("-" * 72)
    out(f"Best guess: {rec['paid_status'].upper()} ({rec['doc_type'].replace('_', ' ')}), "
        f"confidence {rec['confidence'] or 0:.0%}")
    out(f"  {rec['vendor'] or 'unknown vendor'} - {_fmt_amount(rec)} - {rec['purchase_date'] or 'no date'}")
    out(f"  Category: {rec['category']}   Place: {_place(rec) or 'unknown'}")
    out(f"  For: {rec['purpose'] or 'unknown'}" + (f"   Job: {rec['project']}" if rec["project"] else ""))
    if rec["paid_evidence"]:
        out(f"  Evidence: \"{rec['paid_evidence']}\"")
    if rec["notes"]:
        out(f"  Notes: {rec['notes']}")
    if rec["verify_note"]:
        out(f"  Why it needs you: {rec['verify_note']}")
    out("-" * 72)
    body = (rec["body_text"] or "").strip()
    out(textwrap.indent(body[:excerpt_chars] + (" ..." if len(body) > excerpt_chars else ""), "  "))
    out("-" * 72)


def _choose_category(categories: Sequence[str], current: str, ask: Ask, out) -> str:
    for i, c in enumerate(categories, 1):
        out(f"  {i:>2}. {c}")
    while True:
        ans = ask(f"Category [{current}] (Enter = keep, number, or type a new name): ").strip()
        if not ans:
            return current
        if ans.isdigit() and 1 <= int(ans) <= len(categories):
            return categories[int(ans) - 1]
        if not ans.isdigit():
            return ans
        out("  Not a valid number.")


def apply_decision(db: Database, email_id: int, changes: dict, categories: Optional[list[str]] = None) -> None:
    """Save a person's decision and record each change as a correction."""
    rec = db.record(email_id)
    changed = [f for f, new in changes.items() if rec[f] != new]
    for field in changed:
        db.add_correction(email_id, field, rec[field], changes[field])
    if not changed:
        db.add_correction(email_id, "reviewed", None, "ok")  # still counts as a teaching example
    if "category" in changes and categories is not None and changes["category"] not in categories:
        if changes["category"] != UNCATEGORIZED:
            db.add_category(changes["category"])
            categories.append(changes["category"])
    db.update_record(email_id, **changes)
    if changes.get("paid_status") == "not_paid":
        release_duplicates(db, email_id, f"Was linked to email #{email_id}, which you marked not paid")


def review(db: Database, categories: list[str], ask: Ask = input, out=print, include_all: bool = False) -> int:
    try:
        return _review(db, categories, ask, out, include_all)
    except (EOFError, KeyboardInterrupt):
        out("\nStopped. Everything answered so far is saved.")
        link_and_dedupe(db)
        return 0


def _review(db: Database, categories: list[str], ask: Ask, out, include_all: bool) -> int:
    statuses = [NEEDS_REVIEW] if not include_all else None
    items = db.records(statuses)
    if not items:
        out("Nothing to review.")
        return 0
    out(f"{len(items)} item(s) to review. Answers are saved as you go; press q to stop anytime.\n")
    done = 0
    for n, rec in enumerate(items, 1):
        out(f"[{n}/{len(items)}]")
        show(rec, out)
        while True:
            ans = ask("Was this actually PAID?  y = yes, n = no (quote/unpaid/not a purchase), "
                      "o = show whole email, s = skip, q = quit: ").strip().lower()
            if ans == "o":
                out(rec["body_text"] or "(no text)")
                continue
            break
        if ans == "q":
            break
        if ans == "s" or ans not in ("y", "n"):
            continue
        if ans == "n":
            apply_decision(db, rec["email_id"], {"paid_status": "not_paid", "status": EXCLUDED,
                                                 "verify_note": "Marked not paid by you"})
            done += 1
            continue

        changes: dict = {"paid_status": "paid", "status": USER_CONFIRMED, "verify_note": "Confirmed by you"}
        changes["category"] = _choose_category(categories, rec["category"], ask, out)
        for field, label in (("amount", "Amount"), ("currency", "Currency"), ("purchase_date", "Date paid (YYYY-MM-DD)"),
                             ("vendor", "Vendor"), ("city", "City"), ("region", "State/region"),
                             ("purpose", "What was it for"), ("project", "Job / project")):
            current = rec[field]
            ans = ask(f"{label} [{'' if current is None else current}]: ").strip()
            if ans:
                if field == "amount":
                    try:
                        changes[field] = float(ans.replace(",", "").lstrip("$€£"))
                    except ValueError:
                        out("  Not a number - keeping the old amount.")
                else:
                    changes[field] = ans
        apply_decision(db, rec["email_id"], changes, categories)
        done += 1
        out("Saved.\n")
    link_and_dedupe(db)
    out(f"Reviewed {done} item(s).")
    return done


def set_fields(db: Database, email_id: int, categories: list[str], paid: Optional[bool] = None, **fields) -> None:
    """Non-interactive edit (used by `invoice-sorter set`)."""
    if db.record(email_id) is None:
        raise SystemExit(f"No analysed email with id {email_id}")
    changes = {k: v for k, v in fields.items() if v is not None}
    if paid is True:
        changes.update(paid_status="paid", status=USER_CONFIRMED, verify_note="Confirmed by you")
    elif paid is False:
        changes.update(paid_status="not_paid", status=EXCLUDED, verify_note="Marked not paid by you")
    apply_decision(db, email_id, changes, categories)
    link_and_dedupe(db)


def examples_for_prompt(db: Database) -> list[dict]:
    return [dict(r) for r in db.reviewed_examples() if r["paid_status"] in ("paid", "not_paid")]


