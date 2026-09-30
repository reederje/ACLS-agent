from pathlib import Path

import pytest

from app import create_app
from app.extensions import db
from app.models import User

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture

def app(tmp_path):
    database_path = tmp_path / "test.sqlite3"
    application = create_app({
        "TESTING": True,
        "WTF_CSRF_ENABLED": False,
        "RATELIMIT_ENABLED": False,
        "SQLALCHEMY_DATABASE_URI": f"sqlite:///{database_path.as_posix()}",
        "PATIENT_FIXTURE_DIR": str(ROOT / "app" / "fixtures" / "patients"),
        "SECRET_KEY": "test-only-secret-key",
    })
    with application.app_context():
        db.create_all()
        recorder = User(username="test-recorder", role="recorder")
        recorder.set_password("test-recorder-password-123")
        viewer = User(username="test-viewer", role="viewer")
        viewer.set_password("test-viewer-password-123")
        db.session.add_all([recorder, viewer])
        db.session.commit()
        yield application
        db.session.remove()
        db.drop_all()


@pytest.fixture

def client(app):
    return app.test_client()


def login(client, username, password):
    return client.post("/login", data={"username": username, "password": password}, follow_redirects=True)
