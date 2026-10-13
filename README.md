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

## Getting started on Windows (no installing, no typing commands)

1. **Download** [PaidPurchases.exe](https://github.com/undacovacobra/email-invoices/releases/latest/download/PaidPurchases.exe)
   (sign in to GitHub first if it asks).
2. **Double-click** it. If Windows says *"Windows protected your PC"*, click **More info**, then **Run anyway**.
   (That message shows for any program that isn't from a big software company.)
3. **Answer the three setup questions.** It only asks once:
   - your company name, so invoices you *send* to clients aren't counted as purchases
   - which AI reads your emails. Pick **Free AI on this computer**: it installs the free Ollama program and a
     ~5 GB model by itself, then runs entirely on your PC at no cost. (Claude is also offered: more accurate,
     about a cent per email, needs a paid key.)
   - where your email is. Pick **"The Outlook app on this computer"** for Microsoft 365 / work Outlook,
     so no password is needed.
4. Then just type a number from the menu:

```
 1) Check my email for receipts and invoices
 2) Answer questions about items I wasn't sure of   (3 waiting)
 3) Make the Excel spreadsheet
 4) Show totals
 5) Settings (email accounts, Claude key, categories)
 6) Exit
```

Everything is kept in **Documents\Paid Purchases**: your settings, the data, and each spreadsheet you make.
Your email is only read; nothing is moved, deleted, sent, or marked as read.

**Email options in the setup:**

| Your email | Pick |
|---|---|
| Microsoft 365 / work Outlook, with the Outlook app installed | **The Outlook app on this computer** (no password needed) |
| Gmail / Google Workspace | **Gmail**, then follow the on-screen steps to create an "app password" |
| Yahoo, iCloud, others | **Another email provider** |
| Anything else, or the *new* Outlook app | Drag the emails into a folder, then pick **A folder of emails I saved** (.msg and .eml both work) |

You can add more email accounts any time under **Settings**.

## For developers: command-line version

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
| Outlook desktop app (Windows) | `type: outlook_app` (optional `mailbox:`); needs `pip install -e '.[windows]'` |
| Gmail / Google Workspace | `type: imap`, host `imap.gmail.com`, an [App Password](https://myaccount.google.com/apppasswords) |
| Yahoo, iCloud, Fastmail, most web hosts | `type: imap` with the provider's IMAP host and an app password |
| Anything else | `type: mbox` (exported mailbox) or `type: eml_folder` (folder of `.eml` / `.msg` files) |

## Cost

Each purchase-looking email is one Claude request (attachments included). Uncertain emails get a
second request for the double-check. Newsletters and other unrelated mail are filtered out by
keywords first and never sent.

## Development

```bash
pip install -e '.[dev]'
pytest
```

The Windows `.exe` is built by `.github/workflows/windows-app.yml` on every push. That workflow runs the
tests on Windows, packages the app with PyInstaller, checks it with `PaidPurchases.exe --self-test`, and
publishes it as the latest GitHub release.
