"""Passwordless login: one-time codes sent by email (SMTP) or SMS (Twilio).

Users, pending OTPs and sessions live in SQLite. Codes and session tokens are
only ever stored as HMAC hashes, so a leaked database cannot be used to log in.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
import smtplib
import sqlite3
import threading
import time
from contextlib import closing
from dataclasses import dataclass
from email.message import EmailMessage
from pathlib import Path

import httpx

from .config import settings

log = logging.getLogger("docsum.auth")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")
E164_RE = re.compile(r"^\+[1-9]\d{7,14}$")

OTP_LENGTH = 6
OTP_TTL = 5 * 60            # code valid for 5 minutes
OTP_MAX_ATTEMPTS = 5        # wrong guesses before the code is burned
OTP_RESEND_COOLDOWN = 30    # seconds between sends to one identifier
OTP_MAX_PER_HOUR = 5        # sends per identifier per hour
SESSION_TTL = 30 * 24 * 3600


class AuthError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


@dataclass
class Identifier:
    kind: str   # "email" | "phone"
    value: str  # normalized: lower-case email or E.164 phone


@dataclass
class User:
    id: int
    email: str | None
    phone: str | None

    def to_dict(self) -> dict:
        return {"id": self.id, "email": self.email, "phone": self.phone}


def parse_identifier(raw: str) -> Identifier:
    value = (raw or "").strip()
    if "@" in value:
        email = value.lower()
        if not EMAIL_RE.match(email) or len(email) > 254:
            raise AuthError("Enter a valid email address.")
        return Identifier("email", email)

    phone = re.sub(r"[\s\-().]", "", value)
    if phone.startswith("00"):
        phone = "+" + phone[2:]
    if not phone.startswith("+"):
        if not settings.default_country_code:
            raise AuthError("Enter the mobile number with country code, e.g. +919876543210.")
        phone = settings.default_country_code + phone.lstrip("0")
    if not E164_RE.match(phone):
        raise AuthError("Enter a valid email address or mobile number.")
    return Identifier("phone", phone)


# --------------------------------------------------------------------------- senders
class OtpSender:
    def send(self, ident: Identifier, code: str) -> None:
        raise NotImplementedError


class DefaultSender(OtpSender):
    """SMTP for email, Twilio for SMS; logs the code instead when OTP_DEV_MODE is on."""

    def send(self, ident: Identifier, code: str) -> None:
        if ident.kind == "email" and settings.smtp_host:
            return self._email(ident.value, code)
        if ident.kind == "phone" and settings.twilio_sid:
            return self._sms(ident.value, code)
        if settings.otp_dev_mode:
            log.warning("OTP_DEV_MODE: login code for %s is %s", ident.value, code)
            return
        channel = "email (set SMTP_*)" if ident.kind == "email" else "SMS (set TWILIO_*)"
        raise AuthError(f"Login by {channel} is not configured on the server.", 503)

    def _email(self, to: str, code: str) -> None:
        msg = EmailMessage()
        msg["Subject"] = f"{code} is your Document Summarizer login code"
        msg["From"] = settings.smtp_from or settings.smtp_user
        msg["To"] = to
        msg.set_content(
            f"Your login code is {code}\n\nIt expires in {OTP_TTL // 60} minutes. "
            "If you did not request it, ignore this email."
        )
        try:
            if settings.smtp_ssl:
                server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=20)
            else:
                server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20)
                server.starttls()
            with server:
                if settings.smtp_user:
                    server.login(settings.smtp_user, settings.smtp_password)
                server.send_message(msg)
        except (smtplib.SMTPException, OSError) as exc:
            log.exception("Email OTP send failed")
            raise AuthError(f"Could not send email: {exc}", 502)

    def _sms(self, to: str, code: str) -> None:
        url = f"https://api.twilio.com/2010-04-01/Accounts/{settings.twilio_sid}/Messages.json"
        body = f"{code} is your Document Summarizer login code. It expires in {OTP_TTL // 60} minutes."
        try:
            resp = httpx.post(url, auth=(settings.twilio_sid, settings.twilio_token),
                              data={"To": to, "From": settings.twilio_from, "Body": body}, timeout=20)
        except httpx.HTTPError as exc:
            raise AuthError(f"Could not send SMS: {exc}", 502)
        if resp.status_code >= 300:
            log.error("Twilio error %s: %s", resp.status_code, resp.text[:300])
            raise AuthError("Could not send SMS. Check the number and try again.", 502)


# --------------------------------------------------------------------------- service
class AuthService:
    def __init__(self, db_path: Path, sender: OtpSender | None = None, secret: str | None = None,
                 clock=time.time):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._path = str(db_path)
        # Serializes OTP request/verify so rate limits and attempt counters can't race.
        self._otp_lock = threading.Lock()
        self._sender = sender or DefaultSender()
        self._secret = (secret or _load_secret(db_path.parent / "secret.key")).encode()
        self._now = clock
        with closing(self._connect()) as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT UNIQUE, phone TEXT UNIQUE, created_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS otps (
                    identifier TEXT PRIMARY KEY, code_hash TEXT, expires_at REAL, attempts INTEGER,
                    last_sent_at REAL, window_start REAL, sent_in_window INTEGER);
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
                    created_at REAL NOT NULL, expires_at REAL NOT NULL);
            """)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self._path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def _hash(self, *parts: str) -> str:
        return hmac.new(self._secret, "|".join(parts).encode(), hashlib.sha256).hexdigest()

    def request_otp(self, raw_identifier: str) -> dict:
        ident = parse_identifier(raw_identifier)
        now = self._now()
        with self._otp_lock, closing(self._connect()) as db:
            row = db.execute("SELECT * FROM otps WHERE identifier=?", (ident.value,)).fetchone()
            window_start, sent = (row["window_start"], row["sent_in_window"]) if row else (now, 0)
            if row and now - row["last_sent_at"] < OTP_RESEND_COOLDOWN:
                wait = int(OTP_RESEND_COOLDOWN - (now - row["last_sent_at"])) + 1
                raise AuthError(f"Please wait {wait}s before requesting another code.", 429)
            if now - window_start >= 3600:
                window_start, sent = now, 0
            if sent >= OTP_MAX_PER_HOUR:
                raise AuthError("Too many codes requested. Try again later.", 429)

            code = f"{secrets.randbelow(10 ** OTP_LENGTH):0{OTP_LENGTH}d}"
            self._sender.send(ident, code)  # raises -> nothing is stored
            with db:
                db.execute(
                    "INSERT OR REPLACE INTO otps VALUES (?,?,?,?,?,?,?)",
                    (ident.value, self._hash(ident.value, code), now + OTP_TTL, 0, now, window_start, sent + 1),
                )
        return {"channel": ident.kind, "identifier": _mask(ident), "expires_in": OTP_TTL,
                "resend_after": OTP_RESEND_COOLDOWN}

    def verify_otp(self, raw_identifier: str, code: str) -> tuple[str, User]:
        ident = parse_identifier(raw_identifier)
        code = (code or "").strip()
        now = self._now()
        with self._otp_lock, closing(self._connect()) as db:
            row = db.execute("SELECT * FROM otps WHERE identifier=?", (ident.value,)).fetchone()
            if not row or not row["code_hash"] or now > row["expires_at"]:
                raise AuthError("Code expired or not requested. Request a new code.", 400)
            if row["attempts"] >= OTP_MAX_ATTEMPTS:
                raise AuthError("Too many wrong attempts. Request a new code.", 429)
            if not hmac.compare_digest(row["code_hash"], self._hash(ident.value, code)):
                with db:
                    db.execute("UPDATE otps SET attempts=attempts+1 WHERE identifier=?", (ident.value,))
                left = OTP_MAX_ATTEMPTS - row["attempts"] - 1
                raise AuthError(f"Incorrect code. {left} attempt(s) left." if left else
                                "Incorrect code. Request a new code.", 400)

            with db:
                # Burn the code, keep the rate-limit window.
                db.execute("UPDATE otps SET code_hash=NULL WHERE identifier=?", (ident.value,))
                column = ident.kind  # "email" or "phone" -- fixed strings, safe to interpolate
                user_row = db.execute(f"SELECT * FROM users WHERE {column}=?", (ident.value,)).fetchone()
                if user_row is None:
                    cur = db.execute(f"INSERT INTO users ({column}, created_at) VALUES (?, ?)",
                                           (ident.value, now))
                    user_row = db.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
                token = secrets.token_urlsafe(32)
                db.execute("INSERT INTO sessions VALUES (?,?,?,?)",
                                 (self._hash("session", token), user_row["id"], now, now + SESSION_TTL))
                db.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        return token, _user(user_row)

    def authenticate(self, token: str) -> User | None:
        if not token:
            return None
        with closing(self._connect()) as db:
            row = db.execute(
                "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
                "WHERE s.token_hash=? AND s.expires_at > ?",
                (self._hash("session", token), self._now()),
            ).fetchone()
        return _user(row) if row else None

    def logout(self, token: str) -> None:
        with closing(self._connect()) as db, db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (self._hash("session", token),))


def _user(row: sqlite3.Row) -> User:
    return User(row["id"], row["email"], row["phone"])


def _mask(ident: Identifier) -> str:
    if ident.kind == "email":
        name, domain = ident.value.split("@", 1)
        return f"{name[:2]}{'*' * max(1, len(name) - 2)}@{domain}"
    return f"{ident.value[:3]}{'*' * (len(ident.value) - 6)}{ident.value[-3:]}"


def _load_secret(path: Path) -> str:
    if settings.auth_secret:
        return settings.auth_secret
    if path.is_file():
        return path.read_text().strip()
    secret = secrets.token_hex(32)
    path.write_text(secret)
    path.chmod(0o600)
    return secret
