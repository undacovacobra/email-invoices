"""Cheap keyword score so obviously unrelated mail never reaches the AI."""

from __future__ import annotations

import re

STRONG = [
    "invoice", "receipt", "payment received", "payment confirmation", "paid in full",
    "thank you for your payment", "amount paid", "order confirmation", "your order",
    "quote", "estimate", "proposal", "transaction", "has been charged", "billing statement",
]
WEAK = ["payment", "paid", "order", "purchase", "total", "subtotal", "tax", "balance", "due", "charged", "refund"]
MONEY = re.compile(r"(?:[$€£¥]\s?\d[\d,]*(?:\.\d{2})?)|(?:\b\d[\d,]*\.\d{2}\s?(?:USD|EUR|GBP|CAD|AUD)\b)", re.I)

MIN_SCORE = 2


def score(subject: str, text: str, attachment_names: list[str]) -> int:
    hay = f"{subject}\n{text}".lower()
    s = 0
    s += sum(3 for w in STRONG if w in hay)
    s += sum(1 for w in WEAK if re.search(rf"\b{re.escape(w)}\b", hay))
    if MONEY.search(hay):
        s += 2
    if any(n.lower().endswith(".pdf") for n in attachment_names):
        s += 1
    if any(k in subject.lower() for k in ("invoice", "receipt", "payment", "order", "quote", "estimate")):
        s += 3
    return s
