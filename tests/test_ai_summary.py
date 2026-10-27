import json
from datetime import timedelta

import pytest

from .conftest import login
from app import ai_summary
from app.extensions import db
from app.models import AIResult, utc_now

GOOD_OUTPUT = {
    "summary": "Older adult with coronary artery disease. Recent chest discomfort.",
    "causes": [
        {"name": f"Cause {i}", "rationale": "Because.", "bedside_check": "Check.", "treatment": "Treat."}
        for i in (1, 2, 3)
    ],
}


def record(offset_days, finding, ongoing=False):
    anchor = "2026-06-01T12:00:00+00:00"
    from datetime import datetime
    observed = datetime.fromisoformat(anchor) + timedelta(days=offset_days)
    return {"source_id": f"X-{offset_days}", "observed_at": observed.isoformat(), "ongoing": ongoing, "finding": finding}


def snapshot():
    return {
        "scenario_reference_time": "2026-06-01T12:00:00+00:00",
        "demographics": {"age_years": 64, "age_display": "64 years", "weight_kg": 86},
        "domains": {
            "problems": {"records": [record(-900, {"problem": "Coronary artery disease", "status": "active"}, True)]},
            "medications": {"records": [
                record(-3, {"name": "apixaban", "status": "active"}, True),
                record(-100, {"name": "oldmed", "status": "stopped"}, True),
            ]},
            "allergies": {"records": [record(-1000, {"substance": "penicillin"})]},
            "encounters": {"records": [
                record(-12, {"visit_type": "Ambulatory", "summary": "Chest discomfort"}),
                record(-150, {"visit_type": "Inpatient", "summary": "Too old"}),
            ]},
            "labs": {"records": [
                record(-2, {"test": "potassium", "value": "6.1"}),
                record(-30, {"test": "glucose", "value": "stale"}),
            ]},
        },
    }


def test_context_applies_windows_and_excludes_inactive():
    context = ai_summary.build_context(snapshot())
    assert [e["summary"] for e in context["encounters_past_3_months"]] == ["Chest discomfort"]
    assert [lab["test"] for lab in context["labs_past_7_days"]] == ["potassium"]
    assert [m["name"] for m in context["active_medications"]] == ["apixaban"]
    assert context["allergies"] == [{"substance": "penicillin"}]
    assert context["demographics"]["weight_kg"] == 86


def test_prompt_contains_context_and_no_hard_coded_rules():
    context = ai_summary.build_context(snapshot())
    messages = ai_summary.build_messages(context)
    assert json.loads(messages[1]["content"]) == context
    assert "exactly 3" in messages[0]["content"]


@pytest.mark.parametrize("bad", [{"summary": "x", "causes": GOOD_OUTPUT["causes"][:2]}, {"summary": "x"}, "text"])
def test_validate_output_rejects_malformed(bad):
    with pytest.raises(ValueError):
        ai_summary.validate_output(bad)


def start(client):
    login(client, "test-recorder", "test-recorder-password-123")
    response = client.post("/api/sessions", json={"patient_id": "SYN-A01", "workflow": "cardiac_arrest"})
    assert response.status_code == 201
    return response.get_json()["session_id"]


def test_mock_provider_is_ready_and_labeled(client):
    session_id = start(client)
    body = client.get(f"/api/sessions/{session_id}/ai-summary").get_json()
    assert body["status"] == "ready"
    assert body["provider"] == "mock"
    assert len(body["causes"]) == 3


def test_openai_success_is_stored(app, client, monkeypatch):
    app.config["AI_PROVIDER"] = "openai"
    monkeypatch.setattr(ai_summary, "_call_openai", lambda messages: GOOD_OUTPUT)
    session_id = start(client)
    body = client.get(f"/api/sessions/{session_id}/ai-summary").get_json()
    assert body["status"] == "ready" and body["summary"] == GOOD_OUTPUT["summary"]
    assert body["model"] == "gpt-5.5"
    stored = AIResult.query.filter_by(session_id=session_id).one()
    assert stored.validation_status == "valid" and stored.output == GOOD_OUTPUT


def test_openai_failure_is_unavailable(app, client, monkeypatch):
    app.config["AI_PROVIDER"] = "openai"

    def boom(messages):
        raise TimeoutError("timed out")

    monkeypatch.setattr(ai_summary, "_call_openai", boom)
    session_id = start(client)
    assert client.get(f"/api/sessions/{session_id}/ai-summary").get_json() == {"status": "unavailable"}


def test_invalid_model_output_is_unavailable(app, client, monkeypatch):
    app.config["AI_PROVIDER"] = "openai"
    monkeypatch.setattr(ai_summary, "_call_openai", lambda messages: {"summary": "x", "causes": []})
    session_id = start(client)
    assert client.get(f"/api/sessions/{session_id}/ai-summary").get_json() == {"status": "unavailable"}


def test_pending_then_stale(app, client):
    app.config["AI_SUMMARY_BACKGROUND"] = False
    session_id = start(client)
    result = AIResult.query.filter_by(session_id=session_id).one()
    result.validation_status = "pending"
    result.generated_at = utc_now()
    db.session.commit()
    assert client.get(f"/api/sessions/{session_id}/ai-summary").get_json() == {"status": "pending"}
    result.generated_at = utc_now() - timedelta(seconds=300)
    db.session.commit()
    assert client.get(f"/api/sessions/{session_id}/ai-summary").get_json() == {"status": "unavailable"}


def test_requires_login(client):
    assert client.get("/api/sessions/nope/ai-summary").status_code in (302, 401)
