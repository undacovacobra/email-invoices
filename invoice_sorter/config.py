"""Load config.yaml."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml

DEFAULT_CATEGORIES = [
    "Office Supplies",
    "Software & Subscriptions",
    "Equipment & Hardware",
    "Travel - Airfare",
    "Travel - Lodging",
    "Travel - Ground Transport",
    "Meals & Entertainment",
    "Contractors & Professional Services",
    "Materials & Inventory",
    "Shipping & Postage",
    "Utilities & Telecom",
    "Repairs & Maintenance",
    "Training & Events",
    "Other",
]

DEFAULT_SEARCH_KEYWORDS = [
    "invoice", "receipt", "payment", "paid", "order", "purchase",
    "quote", "estimate", "transaction", "billing", "charged",
]


@dataclass
class AccountConfig:
    name: str
    type: str  # imap | mbox | eml_folder
    host: Optional[str] = None
    port: int = 993
    username: Optional[str] = None
    password_env: Optional[str] = None
    folders: list[str] = field(default_factory=lambda: ["INBOX"])
    since: Optional[str] = None  # YYYY-MM-DD
    path: Optional[str] = None
    search_keywords: list[str] = field(default_factory=lambda: list(DEFAULT_SEARCH_KEYWORDS))

    def password(self) -> str:
        if not self.password_env:
            raise ValueError(f"Account '{self.name}': set password_env to the name of an environment variable")
        value = os.environ.get(self.password_env)
        if not value:
            raise ValueError(f"Account '{self.name}': environment variable {self.password_env} is not set")
        return value


@dataclass
class Config:
    database: str = "invoices.db"
    model: str = "claude-opus-5-5"
    confidence_threshold: float = 0.8
    categories: list[str] = field(default_factory=lambda: list(DEFAULT_CATEGORIES))
    accounts: list[AccountConfig] = field(default_factory=list)
    base_dir: Path = Path(".")

    @property
    def db_path(self) -> Path:
        p = Path(self.database).expanduser()
        return p if p.is_absolute() else self.base_dir / p


def load_config(path: str | Path) -> Config:
    path = Path(path)
    data = yaml.safe_load(path.read_text()) or {}
    accounts = []
    for raw in data.get("accounts") or []:
        raw = dict(raw)
        if raw.get("since") is not None:
            raw["since"] = str(raw["since"])
        if raw.get("path"):
            p = Path(str(raw["path"])).expanduser()
            raw["path"] = str(p if p.is_absolute() else path.parent / p)
        accounts.append(AccountConfig(**raw))
    names = [a.name for a in accounts]
    if len(names) != len(set(names)):
        raise ValueError("Each account needs a unique name")
    return Config(
        database=data.get("database", "invoices.db"),
        model=data.get("model", "claude-opus-5-5"),
        confidence_threshold=float(data.get("confidence_threshold", 0.8)),
        categories=list(data.get("categories") or DEFAULT_CATEGORIES),
        accounts=accounts,
        base_dir=path.parent,
    )
