import pytest
from fastapi.testclient import TestClient

from docsum.auth import AuthError, AuthService, parse_identifier
from tests.test_app import app, fake, sender  # noqa: F401  (pytest fixtures)
from tests.test_app import CapturingSender, login, make_pdf, upload


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


@pytest.fixture
def svc(tmp_path):
    clock = Clock()
    sender = CapturingSender()
    return AuthService(tmp_path / "auth.db", sender=sender, secret="test", clock=clock), sender, clock


def test_parse_identifier():
    assert parse_identifier(" User@Example.COM ").value == "user@example.com"
    assert parse_identifier("+91 98765-43210").value == "+919876543210"
    assert parse_identifier("0091 9876543210").value == "+919876543210"
    for bad in ["nope", "a@b", "+12", "12345"]:
        with pytest.raises(AuthError):
            parse_identifier(bad)
    from docsum import auth
    object.__setattr__(auth.settings, "default_country_code", "+91")
    try:
        assert parse_identifier("09876543210").value == "+919876543210"
    finally:
        object.__setattr__(auth.settings, "default_country_code", "")


def test_otp_happy_path_and_single_use(svc):
    auth, sender, _ = svc
    info = auth.request_otp("a@example.com")
    assert info["channel"] == "email" and "*" in info["identifier"]
    code = sender.sent["a@example.com"]
    token, user = auth.verify_otp("A@example.com", code)
    assert user.email == "a@example.com"
    assert auth.authenticate(token).id == user.id
    with pytest.raises(AuthError):
        auth.verify_otp("a@example.com", code)  # already used
    auth.logout(token)
    assert auth.authenticate(token) is None


def test_same_user_on_relogin_and_phone_users_separate(svc):
    auth, sender, clock = svc
    auth.request_otp("+15551234567")
    _, u1 = auth.verify_otp("+15551234567", sender.sent["+15551234567"])
    clock.t += 60
    auth.request_otp("+1 555 123 4567")
    _, u2 = auth.verify_otp("+15551234567", sender.sent["+15551234567"])
    assert u1.id == u2.id and u1.phone == "+15551234567"


def test_wrong_code_attempt_limit_and_expiry(svc):
    auth, sender, clock = svc
    auth.request_otp("b@example.com")
    code = sender.sent["b@example.com"]
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(5):
        with pytest.raises(AuthError):
            auth.verify_otp("b@example.com", wrong)
    with pytest.raises(AuthError) as exc:
        auth.verify_otp("b@example.com", code)  # locked even with right code
    assert exc.value.status == 429

    clock.t += 31
    auth.request_otp("b@example.com")
    clock.t += 301
    with pytest.raises(AuthError, match="expired"):
        auth.verify_otp("b@example.com", sender.sent["b@example.com"])


def test_rate_limits(svc):
    auth, _, clock = svc
    auth.request_otp("c@example.com")
    with pytest.raises(AuthError) as exc:
        auth.request_otp("c@example.com")
    assert exc.value.status == 429
    for _ in range(4):
        clock.t += 31
        auth.request_otp("c@example.com")
    clock.t += 31
    with pytest.raises(AuthError, match="Too many"):
        auth.request_otp("c@example.com")
    clock.t += 3600
    auth.request_otp("c@example.com")


def test_api_requires_login_and_isolates_users(app, sender):
    anon = TestClient(app)
    assert anon.get("/api/documents").status_code == 401
    assert anon.post("/api/qa", json={"question": "x"}).status_code == 401
    assert anon.get("/api/health").status_code == 200

    alice, bob = TestClient(app), TestClient(app)
    login(alice, sender, "alice@example.com")
    login(bob, sender, "+15550001111")
    doc = upload(alice, "report.pdf", make_pdf()).json()

    assert alice.get("/api/auth/me").json()["email"] == "alice@example.com"
    assert len(alice.get("/api/documents").json()) == 1
    assert bob.get("/api/documents").json() == []
    assert bob.get(f"/api/documents/{doc['id']}").status_code == 404
    assert bob.delete(f"/api/documents/{doc['id']}").status_code == 404
    assert bob.post("/api/qa", json={"question": "revenue"}).json()["sources"] == []
    assert alice.post("/api/qa", json={"question": "revenue"}).json()["sources"]

    assert alice.post("/api/auth/logout").status_code == 200
    assert alice.get("/api/documents").status_code == 401
