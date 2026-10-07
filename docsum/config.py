import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv(path: Path = Path(".env")) -> None:
    """Minimal .env loader so the app works without python-dotenv."""
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


def _bool(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    ollama_url: str = field(default_factory=lambda: os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/"))
    ollama_model: str = field(default_factory=lambda: os.getenv("OLLAMA_MODEL", "qwen2.5:7b"))
    embed_model: str = field(default_factory=lambda: os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text"))
    ollama_timeout: float = field(default_factory=lambda: float(os.getenv("OLLAMA_TIMEOUT", "300")))
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("DATA_DIR", "./data")).resolve())
    ocr_lang: str = field(default_factory=lambda: os.getenv("OCR_LANG", "eng"))
    tesseract_cmd: str | None = field(default_factory=lambda: os.getenv("TESSERACT_CMD") or None)
    max_upload_mb: int = field(default_factory=lambda: int(os.getenv("MAX_UPLOAD_MB", "50")))

    # --- Login (OTP) ---
    # Secret for hashing codes/session tokens; auto-generated into DATA_DIR if unset.
    auth_secret: str | None = field(default_factory=lambda: os.getenv("AUTH_SECRET") or None)
    # Log OTPs to the server console instead of sending them (development only!).
    otp_dev_mode: bool = field(default_factory=lambda: _bool("OTP_DEV_MODE"))
    # Prefix for mobile numbers typed without a country code, e.g. "+91".
    default_country_code: str = field(default_factory=lambda: os.getenv("DEFAULT_COUNTRY_CODE", ""))
    smtp_host: str = field(default_factory=lambda: os.getenv("SMTP_HOST", ""))
    smtp_port: int = field(default_factory=lambda: int(os.getenv("SMTP_PORT", "587")))
    smtp_user: str = field(default_factory=lambda: os.getenv("SMTP_USER", ""))
    smtp_password: str = field(default_factory=lambda: os.getenv("SMTP_PASSWORD", ""))
    smtp_from: str = field(default_factory=lambda: os.getenv("SMTP_FROM", ""))
    smtp_ssl: bool = field(default_factory=lambda: _bool("SMTP_SSL"))
    twilio_sid: str = field(default_factory=lambda: os.getenv("TWILIO_ACCOUNT_SID", ""))
    twilio_token: str = field(default_factory=lambda: os.getenv("TWILIO_AUTH_TOKEN", ""))
    twilio_from: str = field(default_factory=lambda: os.getenv("TWILIO_FROM_NUMBER", ""))
    # Comma-separated origins allowed to call the API from a browser (e.g. Expo web dev server).
    cors_origins: list[str] = field(default_factory=lambda: [
        o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()])


settings = Settings()
