"""Command line: invoice-sorter <command> ..."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

from . import report
from .config import Config, load_config
from .db import Database
from .models import NEEDS_REVIEW
from .pipeline import all_categories, scan
from .review import examples_for_prompt, review, set_fields, show

EXAMPLE_CONFIG = Path(__file__).resolve().parent.parent / "config.example.yaml"


def _open(args) -> tuple[Config, Database]:
    path = Path(args.config)
    if not path.exists():
        raise SystemExit(f"Config file {path} not found. Run `invoice-sorter init` first.")
    cfg = load_config(path)
    return cfg, Database(cfg.db_path)


def _analyzer(args, cfg: Config, db: Database):
    cats = all_categories(cfg, db)
    if args.offline:
        from .analyzers import OfflineAnalyzer

        print("Offline mode: keyword rules only - expect more items in the review queue.")
        return OfflineAnalyzer(cats)
    from .analyzers import ClaudeAnalyzer

    if not (cfg.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
            or shutil.which("ant")):
        raise SystemExit("No Claude credentials found. Set ANTHROPIC_API_KEY (or run `ant auth login`), "
                         "or use --offline.")
    return ClaudeAnalyzer(cfg.model, cats, examples_for_prompt(db), company=cfg.company,
                          api_key=cfg.anthropic_api_key)


def cmd_init(args) -> None:
    dest = Path(args.config)
    if dest.exists():
        raise SystemExit(f"{dest} already exists - edit it directly.")
    shutil.copy(EXAMPLE_CONFIG, dest)
    print(f"Created {dest}. Add your email accounts to it, then run `invoice-sorter scan`.")


def cmd_scan(args) -> None:
    cfg, db = _open(args)
    import anthropic

    try:
        result = scan(cfg, db, _analyzer(args, cfg, db), only=args.account, include_all=args.all,
                      fetch_mail=not args.no_fetch)
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as e:
        raise SystemExit(f"Claude rejected the credentials: {e}")
    print("\nDone.")
    print(f"  Emails stored:             {result.get('emails', 0)}")
    print(f"  Paid (confident):          {result.get('confirmed', 0)}")
    print(f"  Paid (after double-check): {result.get('verified', 0)}")
    print(f"  Paid (confirmed by you):   {result.get('user_confirmed', 0)}")
    print(f"  Quotes/unpaid/other:       {result.get('excluded', 0)}")
    print(f"  Duplicates merged:         {result.get('duplicate', 0)}")
    print(f"  Waiting for your review:   {result.get('needs_review', 0)}")
    if result.get("needs_review"):
        print("\nRun `invoice-sorter review` to go through the uncertain ones.")


def cmd_review(args) -> None:
    cfg, db = _open(args)
    review(db, all_categories(cfg, db), include_all=args.all)


def cmd_show(args) -> None:
    _, db = _open(args)
    rec = db.record(args.id)
    if rec is None:
        raise SystemExit(f"No analysed email with id {args.id}")
    show(rec, excerpt_chars=100_000)


def cmd_set(args) -> None:
    cfg, db = _open(args)
    paid = True if args.paid else False if args.not_paid else None
    set_fields(db, args.id, all_categories(cfg, db), paid=paid, category=args.category, amount=args.amount,
               currency=args.currency, purchase_date=args.date, vendor=args.vendor, city=args.city,
               region=args.region, country=args.country, purpose=args.purpose, project=args.project)
    print("Saved.")
    show(db.record(args.id), excerpt_chars=0)


def _filtered(args, db):
    return report.paid_purchases(db, since=args.since, until=args.until, category=args.category, place=args.place)


def cmd_summary(args) -> None:
    _, db = _open(args)
    report.print_summary(_filtered(args, db), args.by)
    n = len(db.records([NEEDS_REVIEW]))
    if n:
        print(f"\nNote: {n} item(s) are waiting for review and are not included yet.")


def cmd_list(args) -> None:
    _, db = _open(args)
    if args.review:
        rows = db.records([NEEDS_REVIEW])
    else:
        rows = _filtered(args, db)
    report.print_list(rows)
    print(f"\n{len(rows)} item(s)")


def cmd_export(args) -> None:
    _, db = _open(args)
    rows = _filtered(args, db)
    out = Path(args.out)
    if out.suffix.lower() == ".csv":
        report.export_csv(rows, out)
    else:
        report.export_xlsx(db, rows, out)
    print(f"Wrote {len(rows)} paid purchase(s) to {out}")


def _add_filters(p) -> None:
    p.add_argument("--since", help="YYYY-MM-DD")
    p.add_argument("--until", help="YYYY-MM-DD")
    p.add_argument("--category")
    p.add_argument("--place", help="matches city, state, country or address")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="invoice-sorter", description="Find paid invoices and receipts in your email.")
    parser.add_argument("-c", "--config", default="config.yaml")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="create config.yaml from the example").set_defaults(func=cmd_init)

    p = sub.add_parser("scan", help="read new email, find paid purchases, double-check uncertain ones")
    p.add_argument("--account", action="append", help="only this account (repeatable)")
    p.add_argument("--all", action="store_true", help="analyse every email, not just ones that look purchase-related")
    p.add_argument("--offline", action="store_true", help="keyword rules only, no AI")
    p.add_argument("--no-fetch", action="store_true", help="don't read mail, just re-run analysis/verification")
    p.set_defaults(func=cmd_scan)

    p = sub.add_parser("review", help="answer questions about the uncertain items")
    p.add_argument("--all", action="store_true", help="go through every item, not just uncertain ones")
    p.set_defaults(func=cmd_review)

    p = sub.add_parser("show", help="show one item and its email")
    p.add_argument("id", type=int)
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("set", help="correct one item without the interactive review")
    p.add_argument("id", type=int)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--paid", action="store_true")
    g.add_argument("--not-paid", action="store_true")
    for f in ("category", "currency", "date", "vendor", "city", "region", "country", "purpose", "project"):
        p.add_argument(f"--{f}")
    p.add_argument("--amount", type=float)
    p.set_defaults(func=cmd_set)

    p = sub.add_parser("summary", help="totals grouped by date, place, reason...")
    p.add_argument("--by", choices=sorted(report.GROUPERS), default="month")
    _add_filters(p)
    p.set_defaults(func=cmd_summary)

    p = sub.add_parser("list", help="list paid purchases")
    p.add_argument("--review", action="store_true", help="list the items waiting for review instead")
    _add_filters(p)
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("export", help="write a spreadsheet (.xlsx with grouped tabs, or .csv)")
    p.add_argument("--out", default="paid_purchases.xlsx")
    _add_filters(p)
    p.set_defaults(func=cmd_export)
    return parser


def main(argv=None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main(sys.argv[1:])
