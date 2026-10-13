from datetime import datetime
from types import SimpleNamespace

from invoice_sorter import app
from invoice_sorter.config import load_config
from invoice_sorter.parsing import parse_email
from invoice_sorter.sources import outlook_item_to_bytes


def scripted(answers):
    it = iter(answers)
    return lambda prompt: next(it)


def test_wizard_then_menu(tmp_path, mail_dir, monkeypatch):
    monkeypatch.setenv("PAID_PURCHASES_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(app, "open_file", lambda p: None)
    out = []
    ask = scripted([
        "Coastal Edge",          # company
        "3",                     # keyword matching (no AI)
        "4", str(mail_dir),      # folder of saved emails
        "n",                     # no more accounts
        "1",                     # check email
        "4", "5",                # totals by job/project
        "3",                     # spreadsheet
        "6",                     # exit
    ])
    app.run(ask=ask, out=out.append)

    cfg = load_config(tmp_path / "home" / "settings.yaml")
    assert cfg.company == "Coastal Edge"
    assert cfg.accounts[0].type == "eml_folder"
    text = "\n".join(out)
    assert "Need your answer" in text
    assert list((tmp_path / "home").glob("Paid purchases *.xlsx"))

    # Second start goes straight to the menu, with the waiting count shown.
    out2 = []
    app.run(ask=scripted(["6"]), out=out2.append)
    assert any("waiting)" in line for line in out2)


class FakeAttachments:
    def __init__(self, files):
        self.files = files
        self.Count = len(files)

    def Item(self, i):
        name, data = self.files[i - 1]

        def save(path):
            with open(path, "wb") as f:
                f.write(data)
        return SimpleNamespace(FileName=name, SaveAsFile=save)


def test_outlook_item_conversion():
    props = {
        "http://schemas.microsoft.com/mapi/proptag/0x1035001F": "<abc@vendor.com>",
        "http://schemas.microsoft.com/mapi/proptag/0x1042001F": "<prev@vendor.com>",
    }
    item = SimpleNamespace(
        Subject="Receipt #42", SenderEmailAddress="billing@vendor.com", SenderName="Vendor Billing",
        To="Travis", ReceivedTime=datetime(2026, 9, 23, 14, 5), Body="Paid $111.00", HTMLBody="",
        EntryID="E1", Attachments=FakeAttachments([("invoice.pdf", b"%PDF-1.4")]),
        PropertyAccessor=SimpleNamespace(GetProperty=lambda tag: props.get(tag, "")),
    )
    email = parse_email(outlook_item_to_bytes(item), "outlook")
    assert email.message_id == "<abc@vendor.com>"
    assert email.in_reply_to == "<prev@vendor.com>"
    assert email.from_addr == "Vendor Billing <billing@vendor.com>"
    assert email.date.startswith("2026-09-23")
    assert email.body_text == "Paid $111.00"
    assert [(a.filename, a.content_type) for a in email.attachments] == [("invoice.pdf", "application/pdf")]


def test_outlook_wait_gives_up_instead_of_hanging(monkeypatch):
    import time

    from invoice_sorter import sources

    monkeypatch.setattr(sources, "outlook_mailboxes", lambda: time.sleep(5) or ["x"])
    start = time.time()
    assert sources.outlook_mailboxes_waiting(0.3) is None
    assert time.time() - start < 2
    monkeypatch.setattr(sources, "outlook_mailboxes", lambda: ["travis@coastaledgedesign.com"])
    assert sources.outlook_mailboxes_waiting(5) == ["travis@coastaledgedesign.com"]
