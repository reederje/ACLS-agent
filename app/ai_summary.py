"""LLM-generated patient summary and top-3 potential causes of cardiac arrest (advisory only)."""

import copy
import json
import logging
from datetime import datetime, timedelta, timezone
from threading import Thread

from flask import current_app
from jsonschema import Draft202012Validator

from .extensions import db
from .models import AIResult, CodeSession, utc_now
from .patient_data import _subtract_calendar_months

logger = logging.getLogger(__name__)

PROMPT_VERSION = "ai-summary-v1"
ENCOUNTER_LOOKBACK_MONTHS = 3
LAB_LOOKBACK_DAYS = 7
PENDING_GRACE_SECONDS = 15

OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "causes"],
    "properties": {
        "summary": {"type": "string", "minLength": 1, "maxLength": 900},
        "causes": {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name", "rationale", "bedside_check", "treatment"],
                "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": 120},
                    "rationale": {"type": "string", "minLength": 1, "maxLength": 400},
                    "bedside_check": {"type": "string", "minLength": 1, "maxLength": 600},
                    "treatment": {"type": "string", "minLength": 1, "maxLength": 600},
                },
            },
        },
    },
}
_VALIDATOR = Draft202012Validator(OUTPUT_SCHEMA)

SYSTEM_PROMPT = """You are a clinical decision-support assistant for a simulated adult resuscitation (ACLS) team. \
All patients are synthetic. Your output is advisory only and is reviewed by a clinician.

You receive a JSON patient context: demographics, weight, allergies, diagnoses, currently active medications, \
encounters from the past 3 months (visit type and chief complaint/summary), and laboratory values from the past 7 days.

Produce two things:
1. "summary": 2 to 3 sentences summarizing the patient's medical history and the recent complaints at any visits \
in the past 3 months. State only facts present in the context; do not invent history. If there is little or no \
history, say so.
2. "causes": exactly 3 of the most likely potential causes of cardiac arrest for THIS patient, ranked most to least \
likely. Reason from the patient's age, history, medications, recent complaints, and labs. The Hs and Ts \
(hypovolemia, hypoxia, hydrogen ion/acidosis, hypo-/hyperkalemia, hypoglycemia, hypothermia, tension \
pneumothorax, tamponade, toxins, thrombosis [coronary or pulmonary]) are a useful checklist, but you may name \
any other cause, such as trauma or hemorrhage, when it fits better. Do not default to a generic list; \
tailor the ranking to the context. Each cause has:
   - "name": short cause name.
   - "rationale": one sentence linking the cause to specific details in this patient's context.
   - "bedside_check": a concise recommended bedside check or test to confirm or exclude this cause during a code.
   - "treatment": a concise recommended treatment if this cause is suspected.

Respond with JSON only, matching the provided schema."""


def build_context(snapshot: dict) -> dict:
    """Reduce the frozen session snapshot to the inputs the LLM is allowed to see."""
    anchor = datetime.fromisoformat(snapshot["scenario_reference_time"])
    encounter_cutoff = _subtract_calendar_months(anchor, ENCOUNTER_LOOKBACK_MONTHS)
    lab_cutoff = anchor - timedelta(days=LAB_LOOKBACK_DAYS)
    domains = snapshot.get("domains", {})

    def records(name: str) -> list[dict]:
        return domains.get(name, {}).get("records", [])

    def recent(name: str, cutoff: datetime) -> list[dict]:
        return [r for r in records(name) if datetime.fromisoformat(r["observed_at"]) >= cutoff]

    demographics = snapshot.get("demographics", {})
    return {
        "demographics": {
            "age_years": demographics.get("age_years"),
            "age_display": demographics.get("age_display"),
            "weight_kg": demographics.get("weight_kg"),
        },
        "allergies": [r["finding"] for r in records("allergies")],
        "diagnoses": [r["finding"] for r in records("problems")],
        "active_medications": [r["finding"] for r in records("medications") if r["finding"].get("status") == "active"],
        "encounters_past_3_months": [
            {"date": r["observed_at"][:10], **r["finding"]}
            for r in sorted(recent("encounters", encounter_cutoff), key=lambda r: r["observed_at"], reverse=True)
        ],
        "labs_past_7_days": [{"date": r["observed_at"][:10], **r["finding"]} for r in recent("labs", lab_cutoff)],
    }


def build_messages(context: dict) -> list[dict]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(context, indent=2)},
    ]


def validate_output(output) -> None:
    errors = sorted(_VALIDATOR.iter_errors(output), key=lambda err: list(err.path))
    if errors:
        raise ValueError("; ".join(err.message for err in errors))


def _api_schema() -> dict:
    schema = copy.deepcopy(OUTPUT_SCHEMA)
    # Strict structured outputs reject length/count keywords; they are enforced by validate_output.
    for key in ("minItems", "maxItems"):
        schema["properties"]["causes"].pop(key)
    for field in [schema["properties"]["summary"], *schema["properties"]["causes"]["items"]["properties"].values()]:
        field.pop("minLength", None)
        field.pop("maxLength", None)
    return schema


def _call_openai(messages: list[dict]) -> dict:
    from openai import OpenAI

    config = current_app.config
    if not config["OPENAI_API_KEY"]:
        raise RuntimeError("OPENAI_API_KEY is not configured.")
    client = OpenAI(api_key=config["OPENAI_API_KEY"], timeout=config["AI_TIMEOUT_SECONDS"], max_retries=0)
    response = client.chat.completions.create(
        model=config["OPENAI_MODEL"],
        messages=messages,
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "acls_ai_summary", "strict": True, "schema": _api_schema()},
        },
    )
    return json.loads(response.choices[0].message.content)


def _mock_output() -> dict:
    placeholder = {"rationale": "Mock placeholder; no model was called.", "bedside_check": "Mock placeholder.", "treatment": "Mock placeholder."}
    return {
        "summary": "Mock AI summary: no language model was called. Set AI_PROVIDER=openai to generate a real summary.",
        "causes": [{"name": f"Mock cause {index}", **placeholder} for index in (1, 2, 3)],
    }


def generate(context: dict) -> dict:
    if current_app.config["AI_PROVIDER"] == "openai":
        output = _call_openai(build_messages(context))
    else:
        output = _mock_output()
    validate_output(output)
    return output


def create_pending_result(record: CodeSession) -> AIResult:
    config = current_app.config
    result = AIResult(
        session_id=record.id,
        context_hash=record.context_hash,
        session_revision=record.revision,
        output={},
        provider=config["AI_PROVIDER"],
        deployment_id=config["OPENAI_MODEL"] if config["AI_PROVIDER"] == "openai" else None,
        prompt_version=PROMPT_VERSION,
        validation_status="pending",
    )
    db.session.add(result)
    return result


def _run(app, result_id: int) -> None:
    with app.app_context():
        result = db.session.get(AIResult, result_id)
        record = db.session.get(CodeSession, result.session_id)
        try:
            result.output = generate(build_context(record.patient_snapshot))
            result.validation_status = "valid"
        except Exception:
            logger.exception("AI summary generation failed for session %s", result.session_id)
            db.session.rollback()
            result = db.session.get(AIResult, result_id)
            result.output = {}
            result.validation_status = "failed"
        result.generated_at = utc_now()
        db.session.commit()


def start_generation(result_id: int) -> None:
    app = current_app._get_current_object()
    if app.config["AI_SUMMARY_BACKGROUND"]:
        Thread(target=_run, args=(app, result_id), daemon=True).start()
    else:
        _run(app, result_id)


def get_status(session_id: str) -> dict:
    result = AIResult.query.filter_by(session_id=session_id).order_by(AIResult.id.desc()).first()
    if result is None:
        return {"status": "unavailable"}
    status = result.validation_status
    if status == "pending":
        generated_at = result.generated_at
        if generated_at.tzinfo is None:
            generated_at = generated_at.replace(tzinfo=timezone.utc)
        limit = current_app.config["AI_TIMEOUT_SECONDS"] + PENDING_GRACE_SECONDS
        if (utc_now() - generated_at).total_seconds() > limit:
            return {"status": "unavailable"}
        return {"status": "pending"}
    if status != "valid":
        return {"status": "unavailable"}
    return {
        "status": "ready",
        "summary": result.output["summary"],
        "causes": result.output["causes"],
        "provider": result.provider,
        "model": result.deployment_id,
    }
