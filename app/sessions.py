"""Persisted session actions, intervention entries, recorder lease, and status APIs."""

import hashlib
import json
import secrets
from datetime import datetime, timezone
from uuid import uuid4

from flask import Blueprint, abort, current_app, jsonify, render_template, request
from sqlalchemy.exc import IntegrityError

from .ai_summary import create_pending_result, get_status, start_generation
from .auth import current_user, login_required, role_required
from .extensions import db
from .models import AuditEntry, CodeSession, Event, utc_now
from .patient_data import JsonPatientRepository
from .protocol_rules import adult_cardiac_arrest_guidance

sessions = Blueprint("sessions", __name__)
LEASE_SESSION_KEY = "recorder_leases"
VALID_WORKFLOWS = {"cardiac_arrest", "bradycardia_with_pulse", "tachycardia_with_pulse"}


def _repository() -> JsonPatientRepository:
    return JsonPatientRepository(current_app.config["PATIENT_FIXTURE_DIR"])


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    value = _as_utc(value)
    return value.isoformat().replace("+00:00", "Z") if value else None


def _session_or_404(session_id: str) -> CodeSession:
    record = db.session.get(CodeSession, session_id)
    if record is None:
        abort(404)
    return record


def _check_revision(record: CodeSession, payload: dict) -> None:
    revision = payload.get("expected_revision")
    if not isinstance(revision, int) or revision != record.revision:
        abort(409, description=f"Session changed; current revision is {record.revision}.")


def _check_lease(record: CodeSession) -> None:
    user = current_user()
    lease = request.headers.get("X-Recorder-Lease")
    supplied_hash = hashlib.sha256(lease.encode()).hexdigest() if lease else None
    if (
        record.recorder_lease_user_id != user.id
        or not supplied_hash
        or not secrets.compare_digest(record.recorder_lease_token_hash or "", supplied_hash)
    ):
        abort(423, description="Recorder lease is invalid or has been taken over. This session is read-only in this browser.")


def _event(record: CodeSession, event_type: str, payload: dict, occurred_at: datetime | None = None, idempotency_key: str | None = None) -> Event:
    latest_sequence = db.session.query(db.func.max(Event.sequence)).filter_by(session_id=record.id).scalar() or 0
    patient = record.patient_snapshot.get("demographics", {})
    value = Event(
        session_id=record.id,
        event_type=event_type,
        payload=payload,
        occurred_at=occurred_at or utc_now(),
        recorder_id=current_user().id,
        sequence=latest_sequence + 1,
        idempotency_key=idempotency_key or str(uuid4()),
        protocol_version=record.protocol_version,
        weight_snapshot={"kg": patient.get("weight_kg"), "provenance": patient.get("weight_provenance")},
    )
    db.session.add(value)
    return value


def _action_event(record: CodeSession, event_type: str, payload: dict, occurred_at: datetime, action_key: str, index: int) -> Event:
    return _event(record, event_type, payload, occurred_at, f"{action_key}:{index}")


def _effective_events(record: CodeSession) -> list[Event]:
    return Event.query.filter_by(session_id=record.id, effective=True).order_by(Event.occurred_at, Event.sequence).all()


def _state(record: CodeSession) -> dict:
    now = utc_now()
    events = _effective_events(record)
    rhythm = next((event for event in reversed(events) if event.event_type == "rhythm_assessment"), None)
    timeline = [{
        "id": event.id,
        "type": event.event_type,
        "payload": event.payload,
        "occurred_at": _iso(event.occurred_at),
        "recorded_at": _iso(event.recorded_at),
        "sequence": event.sequence,
    } for event in events]
    guidance = adult_cardiac_arrest_guidance(
        lifecycle=record.lifecycle,
        workflow=record.workflow,
        population=record.patient_snapshot.get("demographics", {}).get("population"),
        weight_kg=record.patient_snapshot.get("demographics", {}).get("weight_kg"),
        compression_status=record.compression_status,
        started_at=record.started_at,
        compression_anchor_at=record.compression_anchor_at,
        hold_anchor_at=record.hold_anchor_at,
        events=timeline,
        now=now,
        ruleset_version=record.protocol_version,
    )
    return {
        "id": record.id,
        "patient": record.patient_snapshot,
        "lifecycle": record.lifecycle,
        "workflow": record.workflow,
        "compression_status": record.compression_status,
        "started_at": _iso(record.started_at),
        "compression_anchor_at": _iso(record.compression_anchor_at),
        "hold_anchor_at": _iso(record.hold_anchor_at),
        "ended_at": _iso(record.ended_at),
        "outcome": record.outcome,
        "revision": record.revision,
        "server_time": _iso(now),
        "rhythm_assessment": rhythm.payload if rhythm else None,
        "events": timeline,
        "recommendations": guidance,
        "guidance_status": guidance["summary"],
    }


def _error(message: str, status: int):
    return jsonify(error=message), status


@sessions.post("/api/sessions")
@login_required
@role_required("recorder")
def create_session():
    payload = request.get_json(silent=True) or {}
    patient_id = payload.get("patient_id")
    workflow = payload.get("workflow")
    if not isinstance(patient_id, str) or workflow not in VALID_WORKFLOWS:
        return _error("Select a synthetic patient and an explicit workflow.", 400)
    try:
        fixture = _repository().get_patient(patient_id)
    except KeyError:
        return _error("Synthetic patient was not found.", 404)
    now = utc_now()
    snapshot = _repository().get_patient_context(patient_id, now, lookback_months=6)
    snapshot["demographics"] = fixture["demographics"]
    snapshot["suggested_workflow"] = fixture["suggested_workflow"]
    conflicts = snapshot["domains"]["code_status"]["records"]
    statuses = {str(item["finding"].get("status", "unknown")).lower() for item in conflicts}
    requires_ack = len(statuses) > 1 or any("limited" in status or "dnr" in status for status in statuses)
    if requires_ack and payload.get("code_status_acknowledged") is not True:
        return _error("This case has a code-status limitation or conflict; acknowledge it before creating the session.", 422)

    lease_token = secrets.token_urlsafe(32)
    record = CodeSession(
        patient_id=patient_id,
        patient_snapshot=snapshot,
        context_hash=snapshot["context_hash"],
        protocol_version=current_app.config["PROTOCOL_RULESET_VERSION"],
        workflow=workflow,
        created_by_id=current_user().id,
        recorder_lease_user_id=current_user().id,
        recorder_lease_token_hash=hashlib.sha256(lease_token.encode()).hexdigest(),
    )
    db.session.add(record)
    db.session.flush()
    record.revision = 1
    ai_result = create_pending_result(record)
    db.session.flush()
    ai_result_id = ai_result.id
    db.session.commit()
    start_generation(ai_result_id)
    return jsonify(session_id=record.id, lease_token=lease_token, revision=record.revision), 201


@sessions.get("/sessions/<session_id>")
@login_required
def workspace(session_id: str):
    record = _session_or_404(session_id)
    return render_template("session.html", session_record=record, can_record=current_user().role == "recorder")


@sessions.get("/board/<session_id>")
@login_required
def board(session_id: str):
    _session_or_404(session_id)
    return render_template("board.html", session_id=session_id)


@sessions.get("/api/sessions/<session_id>/state")
@login_required
def session_state(session_id: str):
    record = _session_or_404(session_id)
    return jsonify(_state(record))


@sessions.get("/api/sessions/<session_id>/ai-summary")
@login_required
def ai_summary(session_id: str):
    _session_or_404(session_id)
    return jsonify(get_status(session_id))


@sessions.post("/api/sessions/<session_id>/actions")
@login_required
@role_required("recorder")
def session_action(session_id: str):
    record = _session_or_404(session_id)
    payload = request.get_json(silent=True) or {}
    _check_lease(record)
    action_key = payload.get("idempotency_key")
    try:
        if not isinstance(action_key, str) or str(uuid4().__class__(action_key)) != action_key:
            raise ValueError
    except ValueError:
        return _error("Provide a UUID idempotency key for this action.", 400)
    prior = Event.query.filter(Event.session_id == record.id, Event.idempotency_key.like(f"{action_key}:%")).first()
    if prior:
        return jsonify(_state(record)), 200
    _check_revision(record, payload)
    action = payload.get("action")
    now = utc_now()
    action_event_index = 0

    def record_action_event(event_type: str, event_payload: dict):
        nonlocal action_event_index
        _action_event(record, event_type, event_payload, now, action_key, action_event_index)
        action_event_index += 1

    details = payload.get("details", {})
    if not isinstance(details, dict):
        return _error("Action details must be an object.", 400)
    if record.lifecycle == "ended":
        return _error("Completed sessions cannot be restarted.", 409)

    if action == "start":
        if record.lifecycle != "ready":
            return _error("Session has already started.", 409)
        record.lifecycle = "active"
        record.started_at = now
        record_action_event("session_started", {"workflow": record.workflow})
        if record.workflow == "cardiac_arrest":
            record.compression_status = "running"
            record.compression_anchor_at = now
            record_action_event("compressions_started", {"reason": "session start; explicitly documented"})
    elif action == "hold":
        if record.lifecycle != "active" or record.workflow != "cardiac_arrest" or record.compression_status != "running":
            return _error("Compressions can only be held during an active cardiac-arrest workflow when running.", 409)
        record.compression_status = "held"
        record.hold_anchor_at = now
        record_action_event("compressions_held", {"reason": "recorder documented pause"})
    elif action == "rhythm_assessment":
        if record.lifecycle != "active":
            return _error("Rhythm assessment requires an active session.", 409)
        rhythm = details.get("rhythm")
        pulse = details.get("pulse")
        if rhythm not in {"vf", "vt", "pea", "asystole", "rosc"}:
            return _error("Choose VF, VT, PEA, asystole, or ROSC.", 400)
        if rhythm == "vt":
            if pulse not in {"present", "absent"}:
                return _error("For ventricular tachycardia, document whether a pulse is present or absent.", 400)
        else:
            implied_pulse = "present" if rhythm == "rosc" else "absent"
            if pulse != implied_pulse:
                return _error("Pulse status is implied by the selected rhythm.", 400)
        assessment = {
            "rhythm": rhythm,
            "pulse": pulse,
        }
        record_action_event("rhythm_assessment", assessment)
    elif action == "resume":
        if record.lifecycle != "active" or record.workflow != "cardiac_arrest" or record.compression_status != "held":
            return _error("Compressions are not currently held in an active arrest workflow.", 409)
        hold_event = Event.query.filter_by(
            session_id=record.id, event_type="compressions_held", effective=True
        ).order_by(Event.sequence.desc()).first()
        assessment = Event.query.filter_by(
            session_id=record.id, event_type="rhythm_assessment", effective=True
        ).order_by(Event.sequence.desc()).first()
        if hold_event and (assessment is None or assessment.sequence < hold_event.sequence):
            return _error("Record a rhythm and separate pulse assessment (or Unable to determine) before documenting resumption.", 409)
        record.compression_status = "running"
        record.compression_anchor_at = now
        record.hold_anchor_at = None
        record_action_event("compressions_resumed", {"reason": "recorder documented resumption"})
    elif action == "start_arrest":
        if record.lifecycle != "active" or record.workflow == "cardiac_arrest":
            return _error("This transition requires an active pulse-present workflow.", 409)
        record.workflow = "cardiac_arrest"
        record.compression_status = "running"
        record.compression_anchor_at = now
        record_action_event("cardiac_arrest_started", {"previous_workflow": details.get("previous_workflow")})
        record_action_event("compressions_started", {"reason": "explicit arrest transition"})
    elif action == "cpr_start":
        if record.lifecycle != "active" or record.workflow == "cardiac_arrest" or record.compression_status != "not_started":
            return _error("CPR start is available only for an active pulse-present workflow before CPR has started.", 409)
        record.compression_status = "running"
        record.compression_anchor_at = now
        record_action_event("cpr_started", {"reason": "explicit CPR documentation; workflow remains pulse-present"})
    elif action in {"rosc", "end"}:
        if record.lifecycle != "active":
            return _error("Only an active session can be ended.", 409)
        outcome = "rosc" if action == "rosc" else details.get("outcome")
        if action == "rosc":
            outcome = "rosc"
            record_action_event("rosc", {"documented": True})
        else:
            if not isinstance(outcome, str) or not outcome.strip() or len(outcome) > 100:
                return _error("Provide a short session end reason.", 400)
            record_action_event("session_ended", {"outcome": outcome.strip()})
        record.lifecycle = "ended"
        record.ended_at = now
        record.outcome = outcome
        record.compression_status = "stopped"
        record.compression_anchor_at = None
        record.hold_anchor_at = None
    else:
        return _error("Unknown action.", 400)

    record.revision += 1
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return _error("The update conflicted with another write. Refresh the session and retry.", 409)
    return jsonify(_state(record))


@sessions.post("/api/sessions/<session_id>/events")
@login_required
@role_required("recorder")
def record_event(session_id: str):
    record = _session_or_404(session_id)
    payload = request.get_json(silent=True) or {}
    _check_lease(record)
    if record.lifecycle != "active":
        return _error("Events can only be recorded during an active session.", 409)
    event_type = payload.get("event_type")
    allowed = {"medication_admin", "infusion", "electrical_therapy", "airway", "procedure", "assessment", "other"}
    details = payload.get("payload")
    idempotency_key = payload.get("idempotency_key")
    if event_type not in allowed or not isinstance(details, dict):
        return _error("Choose a supported documentation category and provide structured details.", 400)
    if not isinstance(idempotency_key, str) or not 8 <= len(idempotency_key) <= 80:
        return _error("A client idempotency key is required.", 400)
    existing = Event.query.filter_by(session_id=record.id, idempotency_key=idempotency_key).first()
    if existing:
        return jsonify(_state(record)), 200
    _check_revision(record, payload)
    if not isinstance(details.get("title"), str) or not details["title"].strip():
        return _error("Provide a short event description.", 400)
    if event_type == "medication_admin":
        try:
            dose = float(details.get("dose"))
        except (TypeError, ValueError):
            return _error("Enter the actual administered dose as a number.", 400)
        if dose <= 0 or not details.get("units") or not details.get("route"):
            return _error("Actual medication administration requires a positive dose, units, and route.", 400)
        details["dose"] = dose
    if event_type == "infusion":
        if details.get("activity") not in {"start", "rate_change", "stop"}:
            return _error("Select infusion start, rate change, or stop.", 400)
        if details["activity"] != "stop":
            try:
                rate = float(details.get("rate"))
            except (TypeError, ValueError):
                return _error("Enter the documented infusion rate.", 400)
            if rate <= 0 or not details.get("rate_units"):
                return _error("Infusion rate and rate units are required.", 400)
            details["rate"] = rate
        if not details.get("concentration"):
            return _error("Document concentration or explicitly state that it is not recorded.", 400)
    if event_type == "electrical_therapy":
        therapy_type = details.get("therapy_type")
        if therapy_type not in {"defibrillation", "synchronized_cardioversion", "pacing"}:
            return _error("Select defibrillation, synchronized cardioversion, or pacing.", 400)
        if therapy_type != "pacing":
            try:
                energy = float(details.get("energy_joules"))
            except (TypeError, ValueError):
                return _error("Record delivered energy in joules for shock therapy.", 400)
            if energy <= 0:
                return _error("Delivered energy must be greater than zero.", 400)
            details["energy_joules"] = energy
        elif not details.get("settings"):
            return _error("Record pacing settings when documenting pacing.", 400)
    if event_type == "airway" and (not details.get("device") or not details.get("outcome")):
        return _error("Airway documentation requires device/method and attempt outcome or confirmation.", 400)
    if event_type == "procedure" and not details.get("site"):
        return _error("Access/procedure documentation requires site or procedure details.", 400)
    if event_type == "assessment" and not details.get("finding"):
        return _error("Assessment documentation requires a finding or value with units.", 400)
    if event_type == "other" and not details.get("note"):
        return _error("Other documentation requires free-text details.", 400)
    raw_occurrence = details.pop("occurred_at", None)
    occurred_at = utc_now()
    if raw_occurrence:
        try:
            parsed = datetime.fromisoformat(raw_occurrence.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                return _error("Occurrence time must include a time zone.", 400)
            occurred_at = parsed.astimezone(timezone.utc)
        except (ValueError, AttributeError):
            return _error("Occurrence time is invalid.", 400)
    if len(json.dumps(details, ensure_ascii=False)) > 4000:
        return _error("Event details exceed the size limit.", 413)
    _event(record, event_type, details, occurred_at, idempotency_key)
    record.revision += 1
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        existing = Event.query.filter_by(session_id=record.id, idempotency_key=idempotency_key).first()
        if existing:
            return jsonify(_state(record)), 200
        return _error("Event write conflict. Refresh and retry with the same idempotency key.", 409)
    return jsonify(_state(record)), 201


@sessions.post("/api/sessions/<session_id>/takeover")
@login_required
@role_required("recorder")
def takeover(session_id: str):
    record = _session_or_404(session_id)
    payload = request.get_json(silent=True) or {}
    _check_revision(record, payload)
    reason = payload.get("reason")
    if not isinstance(reason, str) or len(reason.strip()) < 4:
        return _error("Enter a reason for recorder takeover.", 400)
    old_recorder_id = record.recorder_lease_user_id
    token = secrets.token_urlsafe(32)
    record.recorder_lease_user_id = current_user().id
    record.recorder_lease_token_hash = hashlib.sha256(token.encode()).hexdigest()
    record.revision += 1
    db.session.add(AuditEntry(
        session_id=record.id,
        action="lease_takeover",
        old_value={"recorder_id": old_recorder_id},
        new_value={"recorder_id": current_user().id},
        reason=reason.strip()[:500],
        actor_id=current_user().id,
    ))
    db.session.commit()
    return jsonify(lease_token=token, revision=record.revision)
