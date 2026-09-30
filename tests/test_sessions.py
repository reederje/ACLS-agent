from uuid import uuid4

from .conftest import login
from app.extensions import db
from app.models import AuditEntry, User


def create_session(client, patient_id="SYN-A01", workflow="cardiac_arrest", acknowledged=False):
    return client.post("/api/sessions", json={
        "patient_id": patient_id,
        "workflow": workflow,
        "code_status_acknowledged": acknowledged,
    })


def action(client, session_id, lease, revision, name, key=None, details=None):
    return client.post(
        f"/api/sessions/{session_id}/actions",
        headers={"X-Recorder-Lease": lease},
        json={
            "action": name,
            "details": details or {},
            "expected_revision": revision,
            "idempotency_key": key or str(uuid4()),
        },
    )


def test_arrest_start_atomically_records_session_and_compressions(client):
    login(client, "test-recorder", "test-recorder-password-123")
    created = create_session(client)
    assert created.status_code == 201
    session_id, lease = created.json["session_id"], created.json["lease_token"]
    start_key = str(uuid4())

    started = action(client, session_id, lease, 1, "start", start_key)
    assert started.status_code == 200
    assert started.json["lifecycle"] == "active"
    assert started.json["compression_status"] == "running"
    assert started.json["started_at"] == started.json["compression_anchor_at"]
    assert [event["type"] for event in started.json["events"]] == ["session_started", "compressions_started"]

    retried = action(client, session_id, lease, 1, "start", start_key)
    assert retried.status_code == 200
    assert len(retried.json["events"]) == 2
    assert retried.json["revision"] == started.json["revision"]


def test_pulse_present_start_does_not_imply_cpr_or_cycle(client):
    login(client, "test-recorder", "test-recorder-password-123")
    created = create_session(client, "SYN-A04", "bradycardia_with_pulse")
    session_id, lease = created.json["session_id"], created.json["lease_token"]
    response = action(client, session_id, lease, 1, "start")
    assert response.status_code == 200
    assert response.json["started_at"] is not None
    assert response.json["compression_status"] == "not_started"
    assert response.json["compression_anchor_at"] is None
    assert [event["type"] for event in response.json["events"]] == ["session_started"]


def test_hold_assessment_resume_requires_explicit_rhythm_and_pulse(client):
    login(client, "test-recorder", "test-recorder-password-123")
    created = create_session(client)
    session_id, lease = created.json["session_id"], created.json["lease_token"]
    started = action(client, session_id, lease, 1, "start")
    held = action(client, session_id, lease, started.json["revision"], "hold")
    assert held.status_code == 200
    blocked = action(client, session_id, lease, held.json["revision"], "resume")
    assert blocked.status_code == 409

    assessment = action(
        client, session_id, lease, held.json["revision"], "rhythm_assessment",
        details={
            "rhythm": "unable_to_determine",
            "pulse": "unknown",
            "heart_rate_bpm": 121,
            "stable": False,
            "qrs_width": "wide",
            "regularity": "irregular",
        },
    )
    assert assessment.status_code == 200
    saved_assessment = next(event for event in assessment.json["events"] if event["type"] == "rhythm_assessment")
    assert saved_assessment["payload"] == {"rhythm": "unable_to_determine", "pulse": "unknown"}
    resumed = action(client, session_id, lease, assessment.json["revision"], "resume")
    assert resumed.status_code == 200
    assert resumed.json["compression_status"] == "running"
    assert resumed.json["compression_anchor_at"] is not None
    assert resumed.json["hold_anchor_at"] is None


def test_rhythm_assessment_rejects_missing_idempotency_key(client):
    login(client, "test-recorder", "test-recorder-password-123")
    created = create_session(client)
    session_id, lease = created.json["session_id"], created.json["lease_token"]
    started = action(client, session_id, lease, 1, "start")
    held = action(client, session_id, lease, started.json["revision"], "hold")
    response = client.post(
        f"/api/sessions/{session_id}/actions",
        headers={"X-Recorder-Lease": lease},
        json={"action": "rhythm_assessment", "details": {"rhythm": "vf", "pulse": "absent"}, "expected_revision": held.json["revision"]},
    )
    assert response.status_code == 400
    assert "idempotency" in response.json["error"].lower()


def test_conflicting_code_status_requires_acknowledgement(client):
    login(client, "test-recorder", "test-recorder-password-123")
    blocked = create_session(client, "SYN-P05")
    assert blocked.status_code == 422
    allowed = create_session(client, "SYN-P05", acknowledged=True)
    assert allowed.status_code == 201


def test_viewer_cannot_create_session_or_write_events(client):
    login(client, "test-viewer", "test-viewer-password-123")
    assert create_session(client).status_code == 403


def test_manual_event_is_idempotent_and_occurrence_time_is_retained(client):
    login(client, "test-recorder", "test-recorder-password-123")
    created = create_session(client)
    session_id, lease = created.json["session_id"], created.json["lease_token"]
    started = action(client, session_id, lease, 1, "start")
    key = str(uuid4())
    request_body = {
        "event_type": "medication_admin",
        "payload": {"title": "Example medication", "dose": 1.5, "units": "mg", "route": "IV", "occurred_at": "2020-09-30T10:15:00-05:00"},
        "idempotency_key": key,
        "expected_revision": started.json["revision"],
    }
    first = client.post(f"/api/sessions/{session_id}/events", headers={"X-Recorder-Lease": lease}, json=request_body)
    assert first.status_code == 201
    retry = client.post(f"/api/sessions/{session_id}/events", headers={"X-Recorder-Lease": lease}, json=request_body)
    assert retry.status_code == 200
    assert len(retry.json["events"]) == 3
    medication = next(event for event in retry.json["events"] if event["payload"].get("title"))
    assert medication["payload"]["dose"] == 1.5
    assert medication["payload"]["route"] == "IV"
    assert medication["occurred_at"] == "2020-09-30T15:15:00Z"


def test_read_only_board_and_recorder_workspace_render(client):
    login(client, "test-recorder", "test-recorder-password-123")
    created = create_session(client)
    session_id = created.json["session_id"]
    assert client.get(f"/sessions/{session_id}").status_code == 200
    board = client.get(f"/board/{session_id}")
    assert board.status_code == 200
    assert b"READ ONLY" in board.data


def test_medication_entry_script_has_catalog_and_no_suggested_doses(client):
    login(client, "test-recorder", "test-recorder-password-123")
    response = client.get("/static/js/session.js")
    assert response.status_code == 200
    script = response.get_data(as_text=True)
    for medication in (
        "Epinephrine", "Amiodarone", "Lidocaine", "Atropine", "Adenosine",
        "Dopamine infusion", "Epinephrine infusion", "Procainamide", "Sotalol",
        "Magnesium sulfate", "Sodium bicarbonate", "Calcium gluconate",
        "Calcium chloride", "Dextrose 5% (D5)", "Dextrose 10% (D10)",
        "Dextrose 25% (D25)", "Dextrose 50% (D50)", "Naloxone",
    ):
        assert medication in script
    assert "not routine ACLS drugs" in script
    assert "No dose or route is preselected." in script
    bolus_choices = script.split('<optgroup label="Adult ACLS algorithm medications">', 1)[1].split("</optgroup>", 1)[0]
    assert "Dopamine infusion" not in bolus_choices
    assert "Epinephrine infusion" not in bolus_choices
    assert 'infusionSelect.name = "infusion_choice"' in script


def test_pulse_present_transition_to_arrest_is_explicit(client):
    login(client, "test-recorder", "test-recorder-password-123")
    created = create_session(client, "SYN-A04", "bradycardia_with_pulse")
    session_id, lease = created.json["session_id"], created.json["lease_token"]
    started = action(client, session_id, lease, 1, "start")
    assert started.json["compression_status"] == "not_started"
    arrest = action(client, session_id, lease, started.json["revision"], "start_arrest")
    assert arrest.status_code == 200
    assert arrest.json["workflow"] == "cardiac_arrest"
    assert arrest.json["compression_status"] == "running"
    assert [event["type"] for event in arrest.json["events"]][-2:] == ["cardiac_arrest_started", "compressions_started"]


def test_takeover_invalidates_previous_lease_and_is_audited(app, client):
    login(client, "test-recorder", "test-recorder-password-123")
    created = create_session(client)
    session_id, original_lease = created.json["session_id"], created.json["lease_token"]
    with app.app_context():
        second = User(username="second-recorder", role="recorder")
        second.set_password("second-recorder-password-123")
        db.session.add(second)
        db.session.commit()

    other_client = app.test_client()
    login(other_client, "second-recorder", "second-recorder-password-123")
    takeover = other_client.post(
        f"/api/sessions/{session_id}/takeover",
        json={"reason": "Recorder handoff for simulation", "expected_revision": 1},
    )
    assert takeover.status_code == 200
    blocked = action(client, session_id, original_lease, 1, "start")
    assert blocked.status_code == 423

    with app.app_context():
        entry = AuditEntry.query.filter_by(session_id=session_id, action="lease_takeover").one()
        assert entry.reason == "Recorder handoff for simulation"
        assert "lease_token_hash" not in (entry.old_value or {})


def test_rosc_ends_session_and_prevents_restart(client):
    login(client, "test-recorder", "test-recorder-password-123")
    created = create_session(client)
    session_id, lease = created.json["session_id"], created.json["lease_token"]
    started = action(client, session_id, lease, 1, "start")
    ended = action(client, session_id, lease, started.json["revision"], "rosc")
    assert ended.status_code == 200
    assert ended.json["lifecycle"] == "ended"
    assert ended.json["outcome"] == "rosc"
    assert ended.json["compression_status"] == "stopped"
    restart = action(client, session_id, lease, ended.json["revision"], "start")
    assert restart.status_code == 409
