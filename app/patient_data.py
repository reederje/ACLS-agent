"""Validated JSON-backed synthetic patient repository."""

import calendar
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


class FixtureError(ValueError):
    pass


def _subtract_calendar_months(value: datetime, months: int) -> datetime:
    month_index = value.month - 1 - months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return value.replace(year=year, month=month, day=day)


class JsonPatientRepository:
    def __init__(self, fixture_dir: str | Path, schema_path: str | Path | None = None):
        self.fixture_dir = Path(fixture_dir)
        self.schema_path = Path(schema_path) if schema_path else self.fixture_dir.parent / "schema.json"

    def _schema(self) -> dict[str, Any]:
        with self.schema_path.open(encoding="utf-8") as source:
            return json.load(source)

    def list_patients(self) -> list[dict[str, Any]]:
        schema = self._schema()
        validator = Draft202012Validator(schema)
        patients = []
        for path in sorted(self.fixture_dir.glob("*.json")):
            with path.open(encoding="utf-8") as source:
                patient = json.load(source)
            errors = sorted(validator.iter_errors(patient), key=lambda err: list(err.path))
            if errors:
                detail = "; ".join(f"{'.'.join(map(str, err.path))}: {err.message}" for err in errors)
                raise FixtureError(f"Invalid fixture {path.name}: {detail}")
            patients.append(patient)
        return patients

    def get_patient(self, patient_id: str) -> dict[str, Any]:
        for patient in self.list_patients():
            if patient["patient_id"] == patient_id:
                return patient
        raise KeyError(patient_id)

    def get_patient_context(
        self,
        patient_id: str,
        as_of: datetime,
        lookback_months: int = 6,
    ) -> dict[str, Any]:
        """Resolve fixture offsets against the supplied session reference time.

        Recent records are included over the calendar-month window; ongoing problems,
        active medications, allergies, and latest applicable weight/code status are retained.
        A result is never included before its available offset.
        """
        fixture = self.get_patient(patient_id)
        if as_of.tzinfo is None:
            as_of = as_of.replace(tzinfo=timezone.utc)
        anchor = as_of.astimezone(timezone.utc)
        cutoff = _subtract_calendar_months(anchor, lookback_months)
        domains = {}
        for name, domain in fixture["domains"].items():
            included = []
            for record in domain["records"]:
                observed = anchor + timedelta(days=record["observed_offset_days"])
                available = anchor + timedelta(days=record["available_offset_days"])
                if observed > anchor or available > anchor:
                    continue
                keep_ongoing = record.get("ongoing", False) or name in {
                    "allergies", "code_status", "weights"
                }
                if observed >= cutoff or keep_ongoing:
                    resolved = dict(record)
                    resolved["observed_at"] = observed.isoformat()
                    resolved["available_at"] = available.isoformat()
                    resolved["age_label"] = "within 6 months" if observed >= cutoff else "historical"
                    included.append(resolved)
            domains[name] = {"availability": domain["availability"], "records": included}
        context = {
            "patient_id": fixture["patient_id"],
            "display_name": fixture["display_name"],
            "demographics": fixture["demographics"],
            "scenario_reference_time": anchor.isoformat(),
            "lookback_months": lookback_months,
            "domains": domains,
        }
        canonical = json.dumps(context, sort_keys=True, separators=(",", ":"))
        context["context_hash"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return context

    def get_source_record(self, patient_id: str, source_id: str) -> dict[str, Any] | None:
        fixture = self.get_patient(patient_id)
        for domain_name, domain in fixture["domains"].items():
            for record in domain["records"]:
                if record["source_id"] == source_id:
                    return {"domain": domain_name, **record}
        return None
