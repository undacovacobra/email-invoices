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
    type: str  # microsoft365 | outlook_app | imap | mbox | eml_folder
    host: Optional[str] = None
    port: int = 993
    username: Optional[str] = None
    password_env: Optional[str] = None
    password_value: Optional[str] = None  # stored by the setup wizard
    folders: list[str] = field(default_factory=lambda: ["INBOX"])
    since: Optional[str] = None  # YYYY-MM-DD
    path: Optional[str] = None
    mailbox: Optional[str] = None  # outlook_app: which mailbox (blank = all)
    client_id: Optional[str] = None  # microsoft365: the app registration's Application (client) ID
    tenant: Optional[str] = None     # microsoft365: the Directory (tenant) ID
    search_keywords: list[str] = field(default_factory=lambda: list(DEFAULT_SEARCH_KEYWORDS))

    def password(self) -> str:
        if self.password_value:
            return self.password_value
        if not self.password_env:
            raise ValueError(f"Account '{self.name}': no password saved")
        value = os.environ.get(self.password_env)
        if not value:
            raise ValueError(f"Account '{self.name}': environment variable {self.password_env} is not set")
        return value


@dataclass
class Config:
    database: str = "invoices.db"
    model: str = "claude-opus-5-5"
    confidence_threshold: float = 0.8
    company: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    ai: Optional[str] = None  # "local" (free, on this computer), "claude", or "keywords"
    local_model: str = "qwen2.5:7b"
    ollama_url: str = "http://localhost:11434"
    categories: list[str] = field(default_factory=lambda: list(DEFAULT_CATEGORIES))
    accounts: list[AccountConfig] = field(default_factory=list)
    base_dir: Path = Path(".")

    @property
    def db_path(self) -> Path:
        p = Path(self.database).expanduser()
        return p if p.is_absolute() else self.base_dir / p


def load_config(path: str | Path) -> Config:
    path = Path(path)
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
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
        company=data.get("company"),
        anthropic_api_key=data.get("anthropic_api_key"),
        ai=data.get("ai"),
        local_model=data.get("local_model", "qwen2.5:7b"),
        ollama_url=data.get("ollama_url", "http://localhost:11434"),
        categories=list(data.get("categories") or DEFAULT_CATEGORIES),
        accounts=accounts,
        base_dir=path.parent,
    )


def save_config(cfg: Config, path: str | Path) -> None:
    """Write settings back to disk (used by the setup wizard)."""
    defaults = AccountConfig(name="", type="")
    accounts = []
    for a in cfg.accounts:
        entry = {"name": a.name, "type": a.type}
        for key in ("host", "port", "username", "password_env", "password_value", "folders", "since",
                    "path", "mailbox", "client_id", "tenant", "search_keywords"):
            value = getattr(a, key)
            if value not in (None, "") and value != getattr(defaults, key):
                entry[key] = value
        accounts.append(entry)
    data = {
        "company": cfg.company,
        "anthropic_api_key": cfg.anthropic_api_key,
        "ai": cfg.ai,
        "local_model": cfg.local_model,
        "ollama_url": cfg.ollama_url,
        "database": cfg.database,
        "model": cfg.model,
        "confidence_threshold": cfg.confidence_threshold,
        "categories": cfg.categories,
        "accounts": accounts,
    }
    Path(path).write_text(
        "# Settings for Paid Purchases. The setup wizard writes this file; you can also edit it.\n"
        + yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
