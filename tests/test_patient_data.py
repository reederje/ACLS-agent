from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from app.patient_data import JsonPatientRepository

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "app" / "fixtures" / "patients"
SCHEMA_PATH = ROOT / "app" / "fixtures" / "schema.json"


def test_all_ten_fixtures_validate_and_match_required_matrix():
    repository = JsonPatientRepository(FIXTURE_DIR, SCHEMA_PATH)
    patients = repository.list_patients()
    assert len(patients) == 10
    assert {patient["patient_id"] for patient in patients} == {
        *(f"SYN-A{i:02}" for i in range(1, 6)),
        *(f"SYN-P{i:02}" for i in range(1, 6)),
    }


def test_six_month_projection_keeps_ongoing_and_marks_old_records():
    repository = JsonPatientRepository(FIXTURE_DIR, SCHEMA_PATH)
    context = repository.get_patient_context(
        "SYN-A01", datetime(2026, 9, 30, tzinfo=timezone.utc), lookback_months=6
    )
    problems = context["domains"]["problems"]["records"]
    assert any(record["source_id"] == "A01-PRB-1" and record["age_label"] == "historical" for record in problems)
    assert any(record["source_id"] == "A01-ENC-2" for record in context["domains"]["encounters"]["records"])
    assert context["domains"]["allergies"]["availability"] == "empty"


def test_future_results_are_not_leaked(tmp_path):
    from app.patient_data import JsonPatientRepository
    import json

    patient = JsonPatientRepository(FIXTURE_DIR, SCHEMA_PATH).get_patient("SYN-A02")
    future = deepcopy(patient["domains"]["labs"]["records"][0])
    future.update(source_id="A02-LAB-FUTURE", observed_offset_days=2, available_offset_days=3)
    patient["domains"]["labs"]["records"].append(future)
    fixture_dir = tmp_path / "patients"
    fixture_dir.mkdir()
    (fixture_dir / "SYN-A02.json").write_text(json.dumps(patient), encoding="utf-8")
    (tmp_path / "schema.json").write_text(SCHEMA_PATH.read_text(encoding="utf-8"), encoding="utf-8")

    projected = JsonPatientRepository(fixture_dir).get_patient_context(
        "SYN-A02", datetime(2026, 9, 30, tzinfo=timezone.utc)
    )
    ids = {record["source_id"] for record in projected["domains"]["labs"]["records"]}
    assert "A02-LAB-FUTURE" not in ids


def test_stale_weight_and_conflicting_code_status_are_preserved():
    context = JsonPatientRepository(FIXTURE_DIR, SCHEMA_PATH).get_patient_context(
        "SYN-P05", datetime(2026, 9, 30, tzinfo=timezone.utc)
    )
    weights = context["domains"]["weights"]["records"]
    statuses = context["domains"]["code_status"]["records"]
    assert {record["source_id"] for record in weights} == {"P05-WGT-1", "P05-WGT-2"}
    assert {record["source_id"] for record in statuses} == {"P05-CODE-1", "P05-CODE-2"}
    assert context["domains"]["ecg"]["availability"] == "unavailable"
