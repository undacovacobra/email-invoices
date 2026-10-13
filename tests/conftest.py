from email.message import EmailMessage
from pathlib import Path

import pytest

from invoice_sorter.config import AccountConfig, Config
from invoice_sorter.db import Database


def make_email(subject, body, sender, date, msgid, html=None, in_reply_to=None, attachments=()):
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = "me@company.com"
    msg["Subject"] = subject
    msg["Date"] = date
    msg["Message-ID"] = msgid
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")
    for name, ctype, data in attachments:
        maintype, subtype = ctype.split("/")
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    return bytes(msg)


SAMPLES = {
    "receipt": make_email(
        "Your Staples receipt", "Thank you for shopping at Staples, Austin TX.\nPrinter paper x10, toner x2\n"
        "Total: $84.50\nPaid with Visa ending 1234. Transaction ID 99812.",
        "Staples <receipts@staples.com>", "Mon, 02 Mar 2026 10:00:00 -0600", "<r1@staples.com>"),
    "quote": make_email(
        "Quote Q-1001 for panel upgrade", "Hi, here is our estimate for the panel upgrade at 12 Oak St.\n"
        "Quote # Q-1001\nTotal: $2,400.00\nValid until April 30.",
        "ABC Electric <office@abcelectric.com>", "Tue, 03 Mar 2026 09:00:00 -0600", "<q1@abcelectric.com>"),
    "invoice": make_email(
        "Invoice INV-2001", "Invoice # INV-2001 for panel upgrade at 12 Oak St.\nAmount due: $2,400.00\n"
        "Due date: April 15.", "ABC Electric <office@abcelectric.com>", "Wed, 01 Apr 2026 09:00:00 -0600",
        "<i1@abcelectric.com>"),
    "ack": make_email(
        "Re: Invoice INV-2001", "Got it - payment received, thanks for the quick turnaround!\n- Sam",
        "ABC Electric <office@abcelectric.com>", "Fri, 10 Apr 2026 15:00:00 -0600", "<a1@abcelectric.com>",
        in_reply_to="<i1@abcelectric.com>"),
    "newsletter": make_email(
        "Spring newsletter", "Read about our new trail maps and upcoming events.",
        "Parks Dept <news@parks.gov>", "Thu, 05 Mar 2026 08:00:00 -0600", "<n1@parks.gov>"),
}


@pytest.fixture
def mail_dir(tmp_path):
    d = tmp_path / "mail"
    d.mkdir()
    for name, raw in SAMPLES.items():
        (d / f"{name}.eml").write_bytes(raw)
    return d


@pytest.fixture
def cfg(tmp_path, mail_dir):
    return Config(
        database=str(tmp_path / "test.db"),
        accounts=[AccountConfig(name="work", type="eml_folder", path=str(mail_dir))],
        base_dir=tmp_path,
    )


@pytest.fixture
def db(cfg):
    d = Database(cfg.db_path)
    yield d
    d.close()


@pytest.fixture
def fixtures_path():
    return Path(__file__).parent
