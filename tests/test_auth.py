from .conftest import login


def test_passwords_are_hashed_and_recorder_can_open_picker(app, client):
    with app.app_context():
        from app.models import User

        user = User.query.filter_by(username="test-recorder").one()
        assert user.password_hash != "test-recorder-password-123"
        assert user.check_password("test-recorder-password-123")

    response = login(client, "test-recorder", "test-recorder-password-123")
    assert response.status_code == 200
    assert b"SYN-A01" in response.data
    assert b"SYN-P05" in response.data


def test_viewer_cannot_open_recorder_patient_picker(client):
    login(client, "test-viewer", "test-viewer-password-123")
    response = client.get("/patients")
    assert response.status_code == 403


def test_invalid_login_does_not_authenticate(client):
    response = client.post("/login", data={"username": "test-recorder", "password": "wrong"})
    assert response.status_code == 401
    assert client.get("/patients").status_code == 302
