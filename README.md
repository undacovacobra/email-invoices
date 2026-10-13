# invoice-sorter

Goes through one or more email accounts, finds the purchases that were **actually paid**
(paid invoices, receipts, order confirmations, and plain "got your payment, thanks" replies),
leaves out quotes, estimates and unpaid invoices, and organises what's left by **date**,
**place** and **reason for the purchase**.

When it isn't sure whether something was paid, or which category it belongs to, it
**double-checks**. If it's still unsure after that, it **asks you**.

## How it decides

```
your mailboxes ──► keyword filter ──► Claude reads each email (+ PDF/photo attachments)
                                              │
                    confident ◄───────────────┴──────────────► not sure
                        │                                          │
                        │                     1. cross-check against related emails
                        │                        (same thread, same invoice #, same vendor+amount)
                        │                     2. second, stricter look with those emails attached
                        │                                          │
                        │                         settled ◄────────┴────────► still not sure
                        ▼                            ▼                              ▼
                     counted                      counted                  your review queue
```

* **Paid** needs evidence: a receipt, "payment received", a card charge, a transaction ID, a zero
  balance, a PAID stamp. Quotes, estimates, proposals and invoices showing an amount due are
  never counted by themselves.
* **Quote → invoice → "payment received"** about the same job is linked together and counted
  **once**. Details missing from a short "thanks, got it" reply (amount, vendor, place, what it
  was for) are filled in from the invoice it answers. If you later say that payment wasn't
  real, the invoice and quote come back for review.
* **Categories** come only from your list in `config.yaml`. If nothing fits, the item goes to
  verification instead of getting a made-up category.
* **Your answers count most.** Anything you confirm or correct overrides the AI, and your recent
  decisions are shown to Claude as examples on later scans, so similar emails get handled your way.
* Every counted item keeps the evidence quote and a note on how it was settled
  (confident / double-checked / confirmed by you), so you can audit it.

## Setup

Requires Python 3.10+.

```bash
pip install -e .
invoice-sorter init                 # creates config.yaml
export ANTHROPIC_API_KEY=sk-ant-... # from https://console.anthropic.com
```

Edit `config.yaml`: add each email account and adjust the category list. Passwords never go in
the file; each account names an environment variable that holds it.

| Email provider | How to connect |
|---|---|
| Gmail / Google Workspace | `type: imap`, host `imap.gmail.com`, an [App Password](https://myaccount.google.com/apppasswords) (needs 2-step verification) |
| Yahoo, iCloud, Fastmail, most web hosts | `type: imap` with the provider's IMAP host and an app password |
| Outlook / Microsoft 365 work accounts | Most companies turn off password-based IMAP. Export the folder to `.mbox`, or drag the emails into a folder and use `type: eml_folder` |
| Anything else | `type: mbox` (exported mailbox) or `type: eml_folder` (folder of saved `.eml` files) |

Mail is opened read-only: nothing is moved, deleted, or marked as read. Everything is stored
locally in `invoices.db`.

## Daily use

```bash
invoice-sorter scan                 # read new mail from every account, analyse, double-check
invoice-sorter review               # answer questions about the items it couldn't settle
invoice-sorter summary --by month   # or: quarter, year, category, place, city, region, vendor, account
invoice-sorter summary --by place --since 2026-01-01 --category "Travel - Lodging"
invoice-sorter list                 # every paid purchase, one per line
invoice-sorter list --review        # what's waiting for you
invoice-sorter export --out purchases.xlsx
```

The spreadsheet has a filterable **Paid purchases** tab plus tabs grouped **by month, quarter,
category (reason), place, vendor, and email account**, a **month × category** grid, a
**Needs your review** tab, and a **Not counted** tab listing every quote/unpaid invoice/duplicate
with the reason it was left out. Use `--out file.csv` for a plain CSV.

Fixing one item without the interactive review:

```bash
invoice-sorter show 42
invoice-sorter set 42 --paid --category "Equipment & Hardware" --city Denver --region CO
invoice-sorter set 43 --not-paid
```

Other options:

* `scan --account work-gmail` only reads that account.
* `scan --all` analyses every email, not just ones that look purchase-related.
* `scan --offline` uses keyword rules with no AI. It still links related emails, but it never
  decides anything by itself, so everything it finds goes to your review queue.
* `confidence_threshold` in `config.yaml` (default 0.8) sets how sure the AI must be. Raise it
  to be asked more often; lower it to be asked less.

## Cost

Each purchase-looking email is one Claude request (attachments included). Uncertain emails get a
second request for the double-check. Newsletters and other unrelated mail are filtered out by
keywords first and never sent.

## Development

```bash
pip install -e '.[dev]'
pytest
```
