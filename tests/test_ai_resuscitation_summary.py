import json
from datetime import timedelta

from .conftest import login
from app import ai_resuscitation_summary, ai_summary
from app.extensions import db
from app.models import AIResult, CodeSession, utc_now


def structured_summary():
    return {
        "rounds_completed": 2,
        "initial_rhythm": "Unknown / not documented",
        "rounds": [{"round": 1, "rhythm": "VF"}, {"round": 2, "rhythm": "PEA"}],
        "airway_status": "Bag-mask ventilation documented; no advanced airway recorded",
        "vascular_access": ["Peripheral IV"],
        "medications": [{"medication": "Epinephrine", "dose": "1", "units": "mg", "count": 2}],
    }


def create_started_arrest(client, app, elapsed_seconds=0):
    login(client, "test-recorder", "test-recorder-password-123")
    created = client.post("/api/sessions", json={"patient_id": "SYN-A01", "workflow": "cardiac_arrest"})
    assert created.status_code == 201
    body = created.get_json()
    session_id = body["session_id"]
    lease = body["lease_token"]
    started = client.post(
        f"/api/sessions/{session_id}/actions",
        headers={"X-Recorder-Lease": lease},
        json={"action": "start", "details": {}, "expected_revision": body["revision"], "idempotency_key": "7b37a3f4-5cce-4be6-bcab-1bcd709a56f0"},
    )
    assert started.status_code == 200
    if elapsed_seconds:
        with app.app_context():
            record = db.session.get(CodeSession, session_id)
            record.started_at = utc_now() - timedelta(seconds=elapsed_seconds)
            record.compression_anchor_at = record.started_at
            db.session.commit()
    return session_id, lease


def request_update(client, session_id, lease):
    return client.post(
        f"/api/sessions/{session_id}/ai-resuscitation-summary",
        headers={"X-Recorder-Lease": lease},
        json={},
    )


def test_waits_until_two_minutes_and_requires_recorder_lease(app, client):
    session_id, lease = create_started_arrest(client, app)
    assert client.get(f"/api/sessions/{session_id}/ai-resuscitation-summary").get_json() == {"status": "waiting"}
    assert request_update(client, session_id, lease).get_json() == {"status": "waiting"}
    assert AIResult.query.filter_by(prompt_version=ai_resuscitation_summary.PROMPT_VERSION).count() == 0

    with app.app_context():
        record = db.session.get(CodeSession, session_id)
        record.started_at = utc_now() - timedelta(seconds=121)
        db.session.commit()
    assert request_update(client, session_id, "invalid-lease").status_code == 423


def test_due_update_is_persisted_and_deduplicated_per_checkpoint(app, client):
    session_id, lease = create_started_arrest(client, app, elapsed_seconds=121)
    first = request_update(client, session_id, lease)
    second = request_update(client, session_id, lease)
    assert first.status_code == second.status_code == 200
    assert first.json["status"] == "ready"
    assert first.json["checkpoint_index"] == 1
    assert first.json["provider"] == "mock"
    assert first.json["summary"]["rounds_completed"] == 0
    assert first.json["summary"]["medications"] == []
    assert AIResult.query.filter_by(session_id=session_id, prompt_version=ai_resuscitation_summary.PROMPT_VERSION).count() == 1

    with app.app_context():
        stored = AIResult.query.filter_by(session_id=session_id, prompt_version=ai_resuscitation_summary.PROMPT_VERSION).one()
        assert stored.output["input_context"]["patient_history_summary"]
        assert [event["type"] for event in stored.output["input_context"]["events"]] == ["session_started", "compressions_started"]
        assert stored.validation_status == "ready"
        record = db.session.get(CodeSession, session_id)
        record.started_at = utc_now() - timedelta(seconds=241)
        db.session.commit()

    next_checkpoint = request_update(client, session_id, lease)
    assert next_checkpoint.json["status"] == "ready"
    assert next_checkpoint.json["checkpoint_index"] == 2
    assert AIResult.query.filter_by(session_id=session_id, prompt_version=ai_resuscitation_summary.PROMPT_VERSION).count() == 2


def test_openai_prompt_receives_initial_summary_and_ordered_effective_events(app, client, monkeypatch):
    app.config["AI_PROVIDER"] = "openai"
    monkeypatch.setattr(ai_summary, "_call_openai", lambda messages: {
        "summary": "Patient history for testing.",
        "causes": [
            {"name": f"Cause {index}", "rationale": "Because.", "bedside_check": "Check.", "treatment": "Treat."}
            for index in (1, 2, 3)
        ],
    })
    captured = {}

    def fake_call(messages):
        captured["messages"] = messages
        return structured_summary()

    monkeypatch.setattr(ai_resuscitation_summary, "_call_openai", fake_call)
    session_id, lease = create_started_arrest(client, app, elapsed_seconds=125)
    response = request_update(client, session_id, lease)

    assert response.json["status"] == "ready"
    messages = captured["messages"]
    assert "rounds_completed" in messages[0]["content"]
    assert "Do not infer physiologic response" in messages[0]["content"]
    context = json.loads(messages[1]["content"])
    assert context["patient_history_summary"] == "Patient history for testing."
    assert [event["type"] for event in context["events"]] == ["session_started", "compressions_started"]
    assert context["events"] == sorted(context["events"], key=lambda event: event["occurred_at"])


def test_invalid_model_output_is_not_displayed(app, client, monkeypatch):
    app.config["AI_PROVIDER"] = "openai"
    monkeypatch.setattr(ai_summary, "_call_openai", lambda messages: {
        "summary": "Patient history for testing.",
        "causes": [
            {"name": f"Cause {index}", "rationale": "Because.", "bedside_check": "Check.", "treatment": "Treat."}
            for index in (1, 2, 3)
        ],
    })
    monkeypatch.setattr(ai_resuscitation_summary, "_call_openai", lambda messages: {"rounds_completed": -1})
    session_id, lease = create_started_arrest(client, app, elapsed_seconds=121)

    response = request_update(client, session_id, lease)
    assert response.json["status"] == "unavailable"
    assert "summary" not in response.json


def test_summary_validation_requires_one_ordered_rhythm_per_round():
    output = structured_summary()
    ai_resuscitation_summary.validate_output(output)

    output["rounds_completed"] = 3
    try:
        ai_resuscitation_summary.validate_output(output)
    except ValueError as error:
        assert "one entry for every completed CPR round" in str(error)
    else:
        raise AssertionError("Expected inconsistent round summary to fail validation")


def test_final_update_is_generated_for_each_session_end_path(app, client):
    for ending_action, details in (("end", {"outcome": "simulation stopped"}), ("rosc", {})):
        session_id, lease = create_started_arrest(client, app)
        state = client.get(f"/api/sessions/{session_id}/state").get_json()
        ended = client.post(
            f"/api/sessions/{session_id}/actions",
            headers={"X-Recorder-Lease": lease},
            json={
                "action": ending_action,
                "details": details,
                "expected_revision": state["revision"],
                "idempotency_key": "f3ff60a3-bdc1-4ce0-a0c7-41e63c1f801e" if ending_action == "end" else "30f61a5a-d404-4d4d-b132-dd5dc4e07a36",
            },
        )
        assert ended.status_code == 200
        summary = client.get(f"/api/sessions/{session_id}/ai-resuscitation-summary").get_json()
        assert summary["status"] == "ready"
        assert summary["is_final"] is True
        assert summary["summary"]


def test_viewer_cannot_request_update(app, client):
    session_id, _lease = create_started_arrest(client, app, elapsed_seconds=121)
    client.post("/logout")
    login(client, "test-viewer", "test-viewer-password-123")
    assert client.post(f"/api/sessions/{session_id}/ai-resuscitation-summary", json={}).status_code == 403