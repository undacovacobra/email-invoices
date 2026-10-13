"""Double-click app: a setup wizard the first time, then a simple numbered menu.

Everything lives in one folder: Documents\\Paid Purchases (settings, data, spreadsheets).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from datetime import date
from pathlib import Path
from typing import Callable, Optional

from . import report
from .config import AccountConfig, Config, load_config, save_config
from .db import Database
from .models import NEEDS_REVIEW
from .pipeline import all_categories, scan
from .review import examples_for_prompt, review
from .sources import outlook_mailboxes_waiting

Ask = Callable[[str], str]
APP_NAME = "Paid Purchases"


def data_dir() -> Path:
    override = os.environ.get("PAID_PURCHASES_HOME")
    if override:
        return Path(override)
    docs = Path.home() / "Documents"
    return (docs if docs.exists() else Path.home()) / APP_NAME


def settings_path() -> Path:
    return data_dir() / "settings.yaml"


def open_file(path: Path) -> None:
    try:
        if sys.platform.startswith("win"):
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.run(["open", str(path)], check=False)
        else:
            subprocess.run(["xdg-open", str(path)], check=False)
    except Exception:
        print(f"Open this file yourself: {path}")


# ----------------------------------------------------------------------------- helpers

def _yes(ask: Ask, question: str, default: bool = True) -> bool:
    hint = "Y/n" if default else "y/N"
    ans = ask(f"{question} [{hint}]: ").strip().lower()
    return default if not ans else ans.startswith("y")


def _choose(ask: Ask, out, options: list[str], prompt: str = "Type a number") -> int:
    for i, opt in enumerate(options, 1):
        out(f"  {i}) {opt}")
    while True:
        ans = ask(f"{prompt}: ").strip()
        if ans.isdigit() and 1 <= int(ans) <= len(options):
            return int(ans) - 1
        out(f"  Please type a number from 1 to {len(options)}.")


def _ask_date(ask: Ask, out) -> str:
    default = f"{date.today().year}-01-01"
    while True:
        ans = ask(f"Look at emails starting from which date? (YYYY-MM-DD, Enter = {default}): ").strip()
        if not ans:
            return default
        try:
            return date.fromisoformat(ans).isoformat()
        except ValueError:
            out("  Please type the date like 2026-01-01.")


def _unique_name(cfg: Config, base: str) -> str:
    base = re.sub(r"[^A-Za-z0-9@._-]+", "-", base).strip("-") or "email"
    names = {a.name for a in cfg.accounts}
    name, n = base, 2
    while name in names:
        name, n = f"{base}-{n}", n + 1
    return name


def check_api_key(key: str) -> Optional[str]:
    """Return None if the key works, else a message."""
    try:
        import anthropic

        anthropic.Anthropic(api_key=key).models.retrieve("claude-opus-5-5")
        return None
    except Exception as e:  # show the reason in plain words
        name = type(e).__name__
        if "Authentication" in name or "PermissionDenied" in name:
            return "That key was not accepted. Copy it again from console.anthropic.com."
        if "Connection" in name:
            return "Couldn't reach Claude - check the internet connection."
        return f"Couldn't check the key ({name})."


# ----------------------------------------------------------------------------- AI choice

def setup_local_ai(cfg: Config, ask: Ask, out) -> bool:
    """Make sure the free AI (Ollama + model) is installed and ready. Returns True when ready."""
    from .local_ai import Ollama, install_ollama

    client = Ollama(cfg.ollama_url)
    if not client.running():
        out("The free AI needs a small free program called Ollama (from ollama.com).")
        if not _yes(ask, "Install it now?"):
            return False
        if not install_ollama(out):
            return False
    try:
        if not client.has_model(cfg.local_model):
            out(f"Downloading the AI model ({cfg.local_model}, about 5 GB, only once). This can take a while...")
            last = [-1]

            def progress(status: str, frac: float) -> None:
                pct = int(frac * 100) if frac >= 0 else -1
                if pct >= 0 and pct // 5 != last[0]:
                    last[0] = pct // 5
                    out(f"  {pct}%")

            client.pull(cfg.local_model, progress)
            out("  Model ready.")
    except Exception as e:
        out(f"Couldn't download the model: {e}")
        return False
    return True


def choose_ai(cfg: Config, ask: Ask, out) -> None:
    i = _choose(ask, out, [
        "Free AI on this computer (recommended - free, private, about a 5 GB one-time download)",
        "Claude (most accurate, about a cent per email, needs a paid key)",
        "Keyword matching only (free and fast, but asks you about most emails)",
    ])
    if i == 0:
        cfg.ai = "local"
        if setup_local_ai(cfg, ask, out):
            out("  The free AI is ready.")
        else:
            out("  OK - you can finish this later under Settings. Until then I'll use keyword matching.")
    elif i == 1:
        out("Get a key at https://console.anthropic.com -> API Keys -> Create Key (add a little credit under Billing).")
        while True:
            key = ask("Paste the key (right-click to paste), or press Enter to go back: ").strip()
            if not key:
                return choose_ai(cfg, ask, out)
            problem = check_api_key(key)
            if problem is None:
                cfg.anthropic_api_key, cfg.ai = key, "claude"
                out("  Key works.")
                return
            out("  " + problem)
    else:
        cfg.ai = "keywords"


def ai_label(cfg: Config) -> str:
    return {"local": f"free AI on this computer ({cfg.local_model})", "claude": "Claude",
            "keywords": "keyword matching"}.get(_ai_mode(cfg), "keyword matching")


def _ai_mode(cfg: Config) -> str:
    if cfg.ai:
        return cfg.ai
    return "claude" if (cfg.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")) else "keywords"


# ----------------------------------------------------------------------------- setup

def add_account(cfg: Config, ask: Ask, out) -> Optional[AccountConfig]:
    out("\nWhere is the email?")
    choice = _choose(ask, out, [
        "Microsoft 365 / work Outlook - sign in with Microsoft (works with the New Outlook)",
        "The classic Outlook app on this computer",
        "Gmail or Google Workspace",
        "Another email provider (Yahoo, iCloud, etc.)",
        "A folder of emails I saved (.msg or .eml files)",
        "Never mind",
    ])
    if choice == 5:
        return None

    if choice == 0:
        return add_microsoft365(cfg, ask, out)
    choice -= 1  # the remaining options keep their original numbering below

    if choice == 0:
        out("\nConnecting to Outlook. This can take up to a minute.")
        out("If Outlook asks whether to allow access, tick 'Allow access for', choose 10 minutes, and click Allow.")
        out("(Check the taskbar for a flashing Outlook icon - the question can hide behind other windows.)")
        boxes = outlook_mailboxes_waiting(90)
        if boxes is None:
            out("\nOutlook didn't answer. Open Outlook yourself, make sure your inbox has loaded and no")
            out("message is waiting for you in it, then try this step again. If you use the 'new Outlook',")
            out("pick option 4 instead and drag your emails into a folder.")
            return None
        if not boxes:
            out("\nI couldn't open the Outlook app. Make sure classic Outlook is installed and you are signed in,")
            out("then try again. (The 'new Outlook' can't be read this way - use option 4 instead:")
            out("drag the emails into a folder.)")
            return None
        out("\nI found these mailboxes in Outlook:")
        pick = _choose(ask, out, boxes + ["All of them"], "Which one")
        mailbox = None if pick == len(boxes) else boxes[pick]
        acct = AccountConfig(name=_unique_name(cfg, "outlook-" + (mailbox or "all")), type="outlook_app",
                             mailbox=mailbox, folders=["INBOX"], since=_ask_date(ask, out))
        out("I'll read your Inbox and all folders inside it. Nothing in Outlook is changed.")

    elif choice in (1, 2):
        if choice == 1:
            host = "imap.gmail.com"
            out("\nGmail needs an 'app password' (not your normal password):")
            out("  1. Open https://myaccount.google.com/apppasswords")
            out("  2. If it says it's not available, turn on 2-Step Verification first.")
            out("  3. Create one (any name), and copy the 16 letters it shows.")
            folders = ["[Gmail]/All Mail"]
        else:
            host = ask("Email server (IMAP) address, e.g. imap.mail.yahoo.com: ").strip()
            folders = ["INBOX"]
        user = ask("Email address: ").strip()
        password = ask("App password (right-click to paste): ").strip()
        if choice == 1:
            password = password.replace(" ", "")  # Google shows it in groups of four
        acct = AccountConfig(name=_unique_name(cfg, user), type="imap", host=host, username=user,
                             password_value=password, folders=folders, since=_ask_date(ask, out))

    else:
        out("\nTip: in Outlook, select the emails (Ctrl+click), then drag them into a folder in File Explorer.")
        raw = ask("Folder location (you can drag the folder into this window): ").strip().strip('"').strip("'")
        path = Path(raw).expanduser()
        if not path.is_dir():
            out(f"  I can't find a folder at {raw!r}.")
            return None
        acct = AccountConfig(name=_unique_name(cfg, "folder-" + path.name), type="eml_folder", path=str(path))

    cfg.accounts.append(acct)
    out(f"Added: {describe(acct)}")
    return acct


GUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
REGISTRATION_STEPS = [
    "One-time setup (about 5 minutes). Microsoft needs to know about this program before it can sign in:",
    "",
    "  1. Open https://entra.microsoft.com and sign in with your work email.",
    "  2. In the search box at the top, type  App registrations  and open it.",
    "  3. Click  + New registration.",
    "       Name:  Paid Purchases",
    "       Who can use it:  'Accounts in this organizational directory only'",
    "       Redirect URI:  leave empty",
    "     Click  Register.",
    "  4. On the page that opens, find  Application (client) ID  and  Directory (tenant) ID.",
    "     You'll paste both here in a moment (there's a copy button next to each).",
    "  5. In the left menu click  Authentication, find  'Allow public client flows',",
    "     switch it to  Yes  (or Enabled), and click  Save.",
    "",
]


def _ask_guid(ask: Ask, out, label: str) -> Optional[str]:
    while True:
        value = ask(f"Paste the {label} (right-click to paste), or press Enter to cancel: ").strip().strip('"')
        if not value:
            return None
        if GUID.match(value):
            return value
        out("  That doesn't look right - it should look like 1a2b3c4d-1234-5678-9abc-1234567890ab.")


def sign_in_microsoft(acct_cfg: AccountConfig, out) -> bool:
    from .microsoft import MicrosoftAccount, SignInError

    out("\nNow sign in. Your browser should open; if it doesn't, go to the address below yourself.")
    try:
        acct = MicrosoftAccount(acct_cfg.client_id, acct_cfg.tenant or "", Path(acct_cfg.path))
        acct.sign_in(out)
        acct_cfg.username = acct.email_address()
    except SignInError as e:
        out(f"\nSign-in didn't work: {e}")
        return False
    except OSError as e:
        out(f"\nCouldn't reach Microsoft: {e}. Check the internet connection and try again.")
        return False
    out(f"\nSigned in as {acct_cfg.username}. You won't need to do this again on this computer.")
    return True


def add_microsoft365(cfg: Config, ask: Ask, out) -> Optional[AccountConfig]:
    out("")
    for line in REGISTRATION_STEPS:
        out(line)
    try:
        import webbrowser

        if _yes(ask, "Open entra.microsoft.com in your browser now?"):
            webbrowser.open("https://entra.microsoft.com")
    except Exception:
        pass
    client_id = _ask_guid(ask, out, "Application (client) ID")
    if not client_id:
        return None
    tenant = _ask_guid(ask, out, "Directory (tenant) ID")
    if not tenant:
        return None
    name = _unique_name(cfg, "microsoft365")
    acct = AccountConfig(name=name, type="microsoft365", client_id=client_id, tenant=tenant,
                         path=str(cfg.base_dir / f"{name}-signin.json"), since=_ask_date(ask, out))
    if not sign_in_microsoft(acct, out):
        out("You can try again under Settings -> Add an email account.")
        return None
    cfg.accounts.append(acct)
    out(f"Added: {describe(acct)}")
    return acct


def describe(a: AccountConfig) -> str:
    if a.type == "microsoft365":
        return f"Microsoft 365 - {a.username or 'work email'} (from {a.since})"
    if a.type == "outlook_app":
        return f"Outlook app - {a.mailbox or 'all mailboxes'} (from {a.since})"
    if a.type == "imap":
        return f"{a.username} (from {a.since})"
    return f"Saved emails in {a.path}"


def setup_wizard(ask: Ask = input, out=print) -> Config:
    folder = data_dir()
    folder.mkdir(parents=True, exist_ok=True)
    cfg = Config(database="purchases.db", base_dir=folder)
    out("=" * 64)
    out(f" Welcome to {APP_NAME}! Let's set things up. This only happens once.")
    out("=" * 64)

    out("\nStep 1 of 3 - Your company")
    out("This lets me tell YOUR purchases apart from invoices you send to clients.")
    cfg.company = ask("Company name: ").strip() or None

    out("\nStep 2 of 3 - Which AI reads your emails")
    choose_ai(cfg, ask, out)

    out("\nStep 3 of 3 - Your email")
    while True:
        add_account(cfg, ask, out)
        if not _yes(ask, "\nAdd another email account?", default=False):
            break

    save_config(cfg, settings_path())
    out(f"\nAll set. Your settings and results are kept in: {folder}")
    return cfg


# ----------------------------------------------------------------------------- menu actions

def _analyzer(cfg: Config, db: Database, out, ask: Ask = input):
    cats = all_categories(cfg, db)
    mode = _ai_mode(cfg)
    if mode == "claude":
        from .analyzers import ClaudeAnalyzer

        return ClaudeAnalyzer(cfg.model, cats, examples_for_prompt(db), company=cfg.company,
                              api_key=cfg.anthropic_api_key)
    if mode == "local":
        from .local_ai import LocalAIAnalyzer

        if setup_local_ai(cfg, ask, out):
            out(f"(Using the free AI on this computer. Each email can take 10-60 seconds.)")
            return LocalAIAnalyzer(cfg.local_model, cats, examples_for_prompt(db), company=cfg.company,
                                   url=cfg.ollama_url)
        out("(The free AI isn't ready - using keyword matching this time.)")
    from .analyzers import OfflineAnalyzer

    return OfflineAnalyzer(cats)


def action_check(cfg: Config, db: Database, ask: Ask, out) -> None:
    if not cfg.accounts:
        out("No email accounts yet - add one under Settings.")
        return
    out("\nChecking your email. This can take a while the first time...\n")
    from .microsoft import SignInError

    try:
        result = scan(cfg, db, _analyzer(cfg, db, out, ask), log=out)
    except SignInError as e:
        out(f"\n{e}")
        for acct in cfg.accounts:
            if acct.type == "microsoft365" and _yes(ask, f"Sign in to {describe(acct)} again now?"):
                if sign_in_microsoft(acct, out):
                    save_config(cfg, settings_path())
                    out("Signed in. Choose 1 again to check your email.")
        return
    paid = result.get("confirmed", 0) + result.get("verified", 0) + result.get("user_confirmed", 0)
    out("\n" + "-" * 50)
    out(f"  Paid purchases found:        {paid}")
    out(f"  Quotes / unpaid / not ours:  {result.get('excluded', 0)}")
    out(f"  Same purchase, merged:       {result.get('duplicate', 0)}")
    out(f"  Need your answer:            {result.get('needs_review', 0)}")
    out("-" * 50)
    if result.get("needs_review"):
        out("Choose 2 on the menu to answer those.")


def action_review(cfg: Config, db: Database, ask: Ask, out) -> None:
    review(db, all_categories(cfg, db), ask=ask, out=out)


def action_spreadsheet(cfg: Config, db: Database, ask: Ask, out) -> None:
    rows = report.paid_purchases(db)
    path = cfg.base_dir / f"Paid purchases {date.today().isoformat()}.xlsx"
    try:
        report.export_xlsx(db, rows, path)
    except PermissionError:
        out("The spreadsheet is open in Excel - close it and try again.")
        return
    out(f"Saved {len(rows)} paid purchase(s) to:\n  {path}")
    open_file(path)


def action_totals(cfg: Config, db: Database, ask: Ask, out) -> None:
    ways = [("month", "By month"), ("quarter", "By quarter"), ("year", "By year"), ("category", "By reason (category)"),
            ("project", "By job / project"), ("place", "By place"), ("vendor", "By vendor"),
            ("account", "By email account")]
    i = _choose(ask, out, [label for _, label in ways], "How should I group them")
    out("")
    report.print_summary(report.paid_purchases(db), ways[i][0], out=out)
    waiting = len(db.records([NEEDS_REVIEW]))
    if waiting:
        out(f"\n({waiting} item(s) are waiting for your answer and aren't counted yet.)")


def action_settings(cfg: Config, db: Database, ask: Ask, out) -> None:
    while True:
        out("\nSettings")
        out(f"Emails are read by: {ai_label(cfg)}")
        out("Email accounts:")
        for a in cfg.accounts or []:
            out(f"  - {describe(a)}")
        if not cfg.accounts:
            out("  (none)")
        i = _choose(ask, out, ["Add an email account", "Remove an email account", "Change which AI reads emails",
                               "Change company name", "Edit categories (opens in Notepad)",
                               "Open the folder with my files", "Back"])
        if i == 0:
            add_account(cfg, ask, out)
        elif i == 1 and cfg.accounts:
            j = _choose(ask, out, [describe(a) for a in cfg.accounts], "Remove which")
            removed = cfg.accounts.pop(j)
            out(f"Removed {describe(removed)}. (Purchases already found from it are kept.)")
        elif i == 2:
            out(f"Right now: {ai_label(cfg)}")
            choose_ai(cfg, ask, out)
        elif i == 3:
            cfg.company = ask(f"Company name [{cfg.company or ''}]: ").strip() or cfg.company
        elif i == 4:
            save_config(cfg, settings_path())
            out("Edit the list under 'categories:' (one per line, starting with '- '), save, and close Notepad.")
            if sys.platform.startswith("win"):
                subprocess.run(["notepad.exe", str(settings_path())], check=False)
            else:
                open_file(settings_path())
            cfg.categories = load_config(settings_path()).categories
        elif i == 5:
            open_file(cfg.base_dir)
        else:
            break
        save_config(cfg, settings_path())


MENU = [
    ("Check my email for receipts and invoices", action_check),
    ("Answer questions about items I wasn't sure of", action_review),
    ("Make the Excel spreadsheet", action_spreadsheet),
    ("Show totals", action_totals),
    ("Settings (email accounts, which AI, categories)", action_settings),
]


def run(ask: Ask = input, out=print) -> None:
    path = settings_path()
    cfg = load_config(path) if path.exists() else setup_wizard(ask, out)
    db = Database(cfg.db_path)
    try:
        while True:
            waiting = len(db.records([NEEDS_REVIEW]))
            out("\n" + "=" * 64)
            out(f" {APP_NAME}" + (f" - {cfg.company}" if cfg.company else ""))
            out("=" * 64)
            labels = [label + (f"  ({waiting} waiting)" if fn is action_review and waiting else "")
                      for label, fn in MENU] + ["Exit"]
            i = _choose(ask, out, labels, "What would you like to do? Type a number")
            if i == len(MENU):
                break
            try:
                MENU[i][1](cfg, db, ask, out)
            except KeyboardInterrupt:
                out("\nStopped.")
            except Exception as e:
                out(f"\nSomething went wrong: {e}")
                out("If it keeps happening, copy this message and send it to whoever set this up.")
    finally:
        db.close()


def self_test() -> int:
    """Used by the Windows build to prove the packaged app works end to end (no email or key needed)."""
    import tempfile

    from .analyzers import ClaudeAnalyzer, OfflineAnalyzer
    from .local_ai import EXTRACTION_SCHEMA, Ollama  # the free-AI support is bundled
    from .microsoft import MicrosoftAccount  # noqa: F401  (Microsoft 365 sign-in is bundled)
    from .sources import build_mime

    assert "$ref" not in str(EXTRACTION_SCHEMA) and not Ollama("http://127.0.0.1:9").running()

    ClaudeAnalyzer("claude-opus-5-5", ["Other"], api_key="sk-test")  # the AI library is bundled
    if sys.platform.startswith("win"):
        import win32com.client  # noqa: F401  (Outlook support is bundled)
    import extract_msg  # noqa: F401

    with tempfile.TemporaryDirectory() as tmp:
        mail = Path(tmp) / "mail"
        mail.mkdir()
        (mail / "r.eml").write_bytes(build_mime(
            subject="Your receipt", sender="Shop <a@shop.com>", to="me", date_value=None,
            message_id="<t1@shop.com>", body="Thank you for your payment. Total: $12.50"))
        cfg = Config(database="t.db", base_dir=Path(tmp),
                     accounts=[AccountConfig(name="t", type="eml_folder", path=str(mail))])
        db = Database(cfg.db_path)
        scan(cfg, db, OfflineAnalyzer(cfg.categories), log=lambda *_: None)
        report.export_xlsx(db, report.paid_purchases(db), Path(tmp) / "t.xlsx")
        ok = len(db.records()) == 1 and (Path(tmp) / "t.xlsx").exists()
        db.close()
    print("self-test", "passed" if ok else "FAILED")
    return 0 if ok else 1


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    try:
        run()
    except (KeyboardInterrupt, EOFError):
        pass
    except Exception as e:
        print(f"\nSomething went wrong: {e}")
        input("Press Enter to close.")


if __name__ == "__main__":
    main()
