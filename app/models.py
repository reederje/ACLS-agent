from datetime import datetime, timezone
from uuid import uuid4

from werkzeug.security import check_password_hash, generate_password_hash

from .extensions import db


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(16), nullable=False)
    active = db.Column(db.Boolean, nullable=False, default=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)

    def set_password(self, password: str) -> None:
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)


class CodeSession(db.Model):
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid4()))
    patient_id = db.Column(db.String(32), nullable=False, index=True)
    patient_snapshot = db.Column(db.JSON, nullable=False)
    context_hash = db.Column(db.String(64), nullable=False)
    protocol_version = db.Column(db.String(80), nullable=False)
    lifecycle = db.Column(db.String(16), nullable=False, default="ready")
    workflow = db.Column(db.String(40), nullable=False)
    compression_status = db.Column(db.String(16), nullable=False, default="not_started")
    created_by_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    recorder_lease_token_hash = db.Column(db.String(64))
    recorder_lease_user_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    started_at = db.Column(db.DateTime(timezone=True))
    compression_anchor_at = db.Column(db.DateTime(timezone=True))
    hold_anchor_at = db.Column(db.DateTime(timezone=True))
    ended_at = db.Column(db.DateTime(timezone=True))
    outcome = db.Column(db.String(80))
    revision = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)
    events = db.relationship("Event", back_populates="session", lazy="select")


class Event(db.Model):
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid4()))
    session_id = db.Column(db.String(36), db.ForeignKey("code_session.id"), nullable=False, index=True)
    event_type = db.Column(db.String(48), nullable=False)
    payload = db.Column(db.JSON, nullable=False)
    occurred_at = db.Column(db.DateTime(timezone=True), nullable=False, index=True)
    recorded_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)
    recorder_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    sequence = db.Column(db.Integer, nullable=False)
    idempotency_key = db.Column(db.String(80), nullable=False)
    protocol_version = db.Column(db.String(80), nullable=False)
    weight_snapshot = db.Column(db.JSON)
    effective = db.Column(db.Boolean, nullable=False, default=True)
    session = db.relationship("CodeSession", back_populates="events")
    __table_args__ = (
        db.UniqueConstraint("session_id", "idempotency_key", name="uq_event_idempotency"),
        db.UniqueConstraint("session_id", "sequence", name="uq_event_sequence"),
    )


class AuditEntry(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.String(36), db.ForeignKey("code_session.id"), nullable=False, index=True)
    event_id = db.Column(db.String(36), db.ForeignKey("event.id"))
    action = db.Column(db.String(24), nullable=False)
    old_value = db.Column(db.JSON)
    new_value = db.Column(db.JSON)
    reason = db.Column(db.String(500), nullable=False)
    actor_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)


class WeightRevision(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.String(36), db.ForeignKey("code_session.id"), nullable=False, index=True)
    kilograms = db.Column(db.Float, nullable=False)
    provenance = db.Column(db.String(32), nullable=False)
    note = db.Column(db.String(500))
    changed_by_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    changed_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)


class AIResult(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.String(36), db.ForeignKey("code_session.id"), nullable=False, index=True)
    context_hash = db.Column(db.String(64), nullable=False)
    session_revision = db.Column(db.Integer, nullable=False)
    output = db.Column(db.JSON, nullable=False)
    provider = db.Column(db.String(32), nullable=False)
    deployment_id = db.Column(db.String(160))
    prompt_version = db.Column(db.String(80), nullable=False)
    validation_status = db.Column(db.String(24), nullable=False)
    generated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)


class NoteRevision(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.String(36), db.ForeignKey("code_session.id"), nullable=False, index=True)
    session_revision = db.Column(db.Integer, nullable=False)
    note_text = db.Column(db.Text, nullable=False)
    generated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)
