"""Data shapes shared across the pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

from pydantic import BaseModel, Field

DocType = Literal[
    "paid_invoice",
    "receipt",
    "payment_confirmation",
    "order_confirmation",
    "unpaid_invoice",
    "quote_or_estimate",
    "not_a_purchase",
]
PaidStatus = Literal["paid", "not_paid", "unclear"]

UNCATEGORIZED = "Uncategorized"

# Record statuses (stored in the database).
CONFIRMED = "confirmed"            # AI was confident on the first pass
VERIFIED = "verified"              # uncertain at first, settled by the verification step
NEEDS_REVIEW = "needs_review"      # still uncertain: waiting for you
USER_CONFIRMED = "user_confirmed"  # you reviewed it (paid or not)
EXCLUDED = "excluded"              # quotes, unpaid invoices, non-purchases
DUPLICATE = "duplicate"            # same purchase as another record (e.g. invoice + receipt)
PENDING_VERIFY = "pending_verify"  # internal: queued for verification

COUNTED_STATUSES = (CONFIRMED, VERIFIED, USER_CONFIRMED)


@dataclass
class Attachment:
    filename: str
    content_type: str
    data: bytes


@dataclass
class RawEmail:
    account: str
    message_id: str
    subject: str
    from_addr: str
    to_addr: str
    date: Optional[str]  # ISO 8601
    body_text: str
    in_reply_to: str = ""
    references: str = ""
    attachments: list[Attachment] = field(default_factory=list)
    raw: bytes = b""


class Location(BaseModel):
    city: Optional[str] = Field(description="City where the purchase/service happened, or the vendor's city")
    region: Optional[str] = Field(description="State / province / region")
    country: Optional[str]
    address: Optional[str] = Field(description="Street address if given")


class Extraction(BaseModel):
    """What the AI pulls out of one email."""

    doc_type: DocType
    paid_status: PaidStatus = Field(
        description="'paid' only when the email shows money actually changed hands"
    )
    paid_evidence: str = Field(
        description="Short verbatim quote from the email/attachment proving payment (or showing it is NOT paid). Empty if none."
    )
    vendor: Optional[str]
    amount: Optional[float] = Field(description="Total actually paid (or quoted/invoiced if not paid), no currency symbol")
    currency: Optional[str] = Field(description="ISO code like USD, EUR")
    purchase_date: Optional[str] = Field(description="YYYY-MM-DD the payment was made (else invoice date)")
    invoice_number: Optional[str] = Field(description="Invoice, receipt, order or quote number")
    location: Location
    purpose: Optional[str] = Field(description="What was bought and why, in a few words")
    category: str = Field(description="Exactly one of the allowed categories, or 'Uncategorized'")
    confidence: float = Field(description="0.0-1.0: how sure you are about paid_status AND category together")
    notes: str = Field(description="Anything uncertain or worth flagging. Empty if nothing.")


class Verification(BaseModel):
    """Second, stricter look at an uncertain record, with related emails as context."""

    paid_status: PaidStatus
    category: str
    confidence: float = Field(description="0.0-1.0")
    reasoning: str = Field(description="One or two sentences a person can check")
    supporting_email_ids: list[int] = Field(description="IDs of related emails that settled the question")
    amount: Optional[float] = Field(description="Corrected/filled amount, or null to keep")
    purchase_date: Optional[str] = Field(description="Corrected/filled YYYY-MM-DD, or null to keep")
    vendor: Optional[str] = Field(description="Corrected/filled vendor, or null to keep")
    purpose: Optional[str] = Field(description="Corrected/filled purpose, or null to keep")
