from copy import deepcopy
from datetime import datetime, timedelta, timezone

from app.protocol_rules import ADULT_ARREST_RULESET_VERSION, adult_cardiac_arrest_guidance

UTC = timezone.utc
ANCHOR = datetime(2026, 10, 8, 12, 0, tzinfo=UTC)


def event(event_type, seconds, payload, sequence):
    return {
        "type": event_type,
        "payload": payload,
        "occurred_at": (ANCHOR + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z"),
        "sequence": sequence,
    }


def guidance(*, events=None, now=None, lifecycle="active", workflow="cardiac_arrest", population="adult", weight_kg=80, compression_status="running", started_at=ANCHOR, compression_anchor_at=ANCHOR, hold_anchor_at=None, ruleset_version=ADULT_ARREST_RULESET_VERSION):
    return adult_cardiac_arrest_guidance(
        lifecycle=lifecycle,
        workflow=workflow,
        population=population,
        weight_kg=weight_kg,
        compression_status=compression_status,
        started_at=started_at,
        compression_anchor_at=compression_anchor_at,
        hold_anchor_at=hold_anchor_at,
        events=events or [],
        now=now or ANCHOR,
        ruleset_version=ruleset_version,
    )


def by_id(result, recommendation_id):
    return next(item for item in result["recommendations"] if item["id"] == recommendation_id)


def test_inactive_or_nonadult_pathways_do_not_receive_adult_rules():
    assert guidance(lifecycle="ready")["status"] == "inactive"
    assert guidance(lifecycle="ended")["status"] == "inactive"
    assert guidance(population="pediatric")["status"] == "not_applicable"
    assert guidance(workflow="bradycardia_with_pulse")["status"] == "not_applicable"


def test_initial_active_arrest_requests_explicit_rhythm_and_pulse():
    result = guidance()
    assert result["status"] == "assessment_required"
    assert result["needs_rhythm_assessment"] is True
    assert result["recommendations"][0]["id"] == "adult-arrest-rhythm-pulse-assessment"
    assert result["ruleset_version"] == ADULT_ARREST_RULESET_VERSION


def test_ready_session_exposes_start_as_first_next_step():
    result = guidance(lifecycle="ready")
    assert result["next_steps"][0]["action"] == "start"
    assert result["next_steps"][0]["id"] == "adult-arrest-start"
    assert result["next_steps"][0].get("due_at") is None


def test_shockable_rhythm_without_pulse_advises_one_shock_and_conditional_meds():
    events = [event("rhythm_assessment", 10, {"rhythm": "vf", "pulse": "absent"}, 3)]
    result = guidance(events=events, now=ANCHOR + timedelta(seconds=20))
    assert result["status"] == "active"
    shock = by_id(result, "adult-arrest-shock")
    assert "one defibrillation shock" in shock["text"]
    assert shock["help"]["href"] == "#shock-recommendations-dialog"
    epi = by_id(result, "adult-arrest-epinephrine-interval")
    assert epi["state"] == "no_administration_documented"
    assert not any(step["id"] == "adult-arrest-antiarrhythmic" for step in result["next_steps"])


def test_shock_documentation_suppresses_repeat_shock_recommendation():
    events = [
        event("rhythm_assessment", 10, {"rhythm": "vt", "pulse": "absent"}, 3),
        event("electrical_therapy", 15, {"therapy_type": "defibrillation", "energy_joules": 200}, 4),
    ]
    result = guidance(events=events, now=ANCHOR + timedelta(seconds=20))
    assert not any(item["id"] == "adult-arrest-shock" for item in result["recommendations"])
    assert by_id(result, "adult-arrest-resume-cpr")["help"]["href"] == "#high-quality-cpr-dialog"


def test_same_minute_shock_uses_event_sequence_when_minute_precision_rounds_it_before_assessment():
    events = [
        event("rhythm_assessment", 55, {"rhythm": "vf", "pulse": "absent"}, 10),
        event("electrical_therapy", 0, {"therapy_type": "defibrillation", "energy_joules": 200}, 11),
    ]
    result = guidance(events=events, now=ANCHOR + timedelta(minutes=1))
    assert not any(item["id"] == "adult-arrest-shock" for item in result["recommendations"])
    assert any(item["id"] == "adult-arrest-resume-cpr" for item in result["recommendations"])


def test_post_shock_next_step_is_immediate_compression_resumption():
    events = [
        event("compressions_held", 9, {"reason": "documented pulse-check pause"}, 2),
        event("rhythm_assessment", 10, {"rhythm": "vf", "pulse": "absent"}, 3),
        event("electrical_therapy", 15, {"therapy_type": "defibrillation", "energy_joules": 200}, 4),
    ]
    result = guidance(
        events=events,
        compression_status="held",
        hold_anchor_at=ANCHOR + timedelta(seconds=9),
        now=ANCHOR + timedelta(seconds=20),
    )
    assert result["next_steps"][0]["id"] == "adult-arrest-resume-cpr"
    assert result["next_steps"][0]["action"] == "resume"
    assert result["next_steps"][0]["title"] == "Resume compressions"
    assert "Immediately resume compressions" in result["next_steps"][0]["text"]


def test_pulseless_shockable_check_offers_immediate_resume_and_defibrillation():
    events = [
        event("compressions_held", 9, {"reason": "documented pause"}, 2),
        event("rhythm_assessment", 10, {"rhythm": "vf", "pulse": "absent"}, 3),
    ]
    result = guidance(
        events=events,
        compression_status="held",
        hold_anchor_at=ANCHOR + timedelta(seconds=9),
        now=ANCHOR + timedelta(seconds=11),
    )
    steps = result["next_steps"]
    assert [step["action"] for step in steps[:2]] == ["resume", "record_shock"]
    assert steps[0]["due_at"] is not None
    assert steps[0]["overdue_at"] is None
    assert steps[1]["due_at"] == steps[1]["overdue_at"]


def _shock_events(count):
    return [
        event("rhythm_assessment", 1, {"rhythm": "vf", "pulse": "absent"}, 1),
        *[
            event("electrical_therapy", index + 1, {"therapy_type": "defibrillation", "energy_joules": 200}, index + 1)
            for index in range(1, count + 1)
        ],
    ]


def test_first_antiarrhythmic_step_appears_after_two_shocks_without_timer():
    result = guidance(events=_shock_events(2), weight_kg=80)
    step = next(step for step in result["next_steps"] if step["id"] == "adult-arrest-antiarrhythmic")
    assert step["dose_number"] == 1
    assert step["no_timer"] is True
    assert "due_at" not in step
    assert step["options"]["amiodarone"]["dose"] == 300
    assert step["options"]["lidocaine"]["dose"] == 80
    assert step["options"]["lidocaine"]["range"] == "80–120 mg (1–1.5 mg/kg)"


def test_second_antiarrhythmic_step_after_two_more_shocks_is_pinned_to_selected_agent():
    events = _shock_events(4) + [
        event("medication_admin", 6, {"title": "Amiodarone", "dose": 300, "units": "mg"}, 8),
    ]
    result = guidance(events=events, weight_kg=80)
    step = next(step for step in result["next_steps"] if step["id"] == "adult-arrest-antiarrhythmic")
    assert step["dose_number"] == 2
    assert step["options"] == {
        "amiodarone": {"dose": 150, "units": "mg", "range": "150 mg IV/IO", "available": True}
    }


def test_antiarrhythmic_not_recommended_more_than_two_doses():
    events = _shock_events(6) + [
        event("medication_admin", 7, {"title": "Amiodarone", "dose": 300}, 9),
        event("medication_admin", 8, {"title": "Amiodarone", "dose": 150}, 10),
    ]
    result = guidance(events=events, weight_kg=80)
    assert not any(step["id"] == "adult-arrest-antiarrhythmic" for step in result["next_steps"])


def test_pea_with_implied_absent_pulse_uses_nonshockable_branch():
    for rhythm in ("pea", "asystole"):
        result = guidance(events=[event("rhythm_assessment", 10, {"rhythm": rhythm, "pulse": "absent"}, 3)])
        assert by_id(result, "adult-arrest-nonshockable-cpr")
        assert by_id(result, "adult-arrest-epinephrine-interval")["interval_minutes"] == {"minimum": 3, "maximum": 5}
        assert not any(item["id"] == "adult-arrest-shock" for item in result["recommendations"])


def test_vt_requires_pulse_to_determine_arrest_branch():
    pulseless = guidance(events=[event("rhythm_assessment", 10, {"rhythm": "vt", "pulse": "absent"}, 3)])
    assert by_id(pulseless, "adult-arrest-shock")

    with_pulse = guidance(events=[event("rhythm_assessment", 10, {"rhythm": "vt", "pulse": "present"}, 3)])
    assert with_pulse["status"] == "pulse_present"
    assert with_pulse["recommendations"][0]["id"] == "adult-arrest-vt-with-pulse"
    assert not any(item["id"] == "adult-arrest-shock" for item in with_pulse["recommendations"])


def test_rosc_has_implied_pulse_and_prompts_for_explicit_session_confirmation():
    result = guidance(events=[event("rhythm_assessment", 10, {"rhythm": "rosc", "pulse": "present"}, 3)])
    assert result["status"] == "pulse_present"
    assert result["next_steps"][0]["action"] == "rosc"


def test_unknown_pulse_or_unsupported_rhythm_does_not_select_a_branch():
    unknown_pulse = guidance(events=[event("rhythm_assessment", 10, {"rhythm": "vt", "pulse": "unknown"}, 3)])
    assert unknown_pulse["status"] == "assessment_required"
    assert "select whether a pulse is present or absent" in by_id(unknown_pulse, "adult-arrest-pulse-unknown")["text"]

    unknown_rhythm = guidance(events=[event("rhythm_assessment", 10, {"rhythm": "unable_to_determine", "pulse": "absent"}, 3)])
    assert unknown_rhythm["status"] == "assessment_required"
    assert by_id(unknown_rhythm, "adult-arrest-rhythm-unknown")


def test_present_pulse_stops_arrest_pathway_recommendations():
    result = guidance(events=[event("rhythm_assessment", 10, {"rhythm": "rosc", "pulse": "present"}, 3)])
    assert result["status"] == "pulse_present"
    assert len(result["recommendations"]) == 1
    assert result["recommendations"][0]["id"] == "adult-arrest-pulse-present"

    after_cycle = guidance(
        events=[event("rhythm_assessment", 10, {"rhythm": "rosc", "pulse": "present"}, 3)],
        now=ANCHOR + timedelta(minutes=3),
    )
    assert after_cycle["status"] == "pulse_present"


def test_two_minute_check_stays_due_until_cycle_is_explicitly_reset():
    events = [event("rhythm_assessment", 10, {"rhythm": "pea", "pulse": "absent"}, 3)]
    result = guidance(events=events, now=ANCHOR + timedelta(minutes=2))
    assert result["status"] == "assessment_required"
    assert result["needs_rhythm_assessment"] is False
    assert result["recommendations"][0]["id"] == "adult-arrest-rhythm-pulse-assessment"
    assert "2-minute" in result["recommendations"][0]["title"]

    without_initial_assessment = guidance(now=ANCHOR + timedelta(minutes=2))
    assert without_initial_assessment["needs_rhythm_assessment"] is False
    assert "pause actually occurs" in without_initial_assessment["recommendations"][0]["text"]


def test_upcoming_two_minute_check_is_scheduled_with_exact_deadline():
    events = [event("rhythm_assessment", 10, {"rhythm": "pea", "pulse": "absent"}, 3)]
    result = guidance(events=events, now=ANCHOR + timedelta(seconds=61))
    step = next(item for item in result["next_steps"] if item["id"] == "adult-arrest-next-pulse-check")
    assert step["due_at"] == (ANCHOR + timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
    assert step["overdue_at"] == step["due_at"]


def test_held_compressions_require_assessment_after_the_documented_hold():
    events = [event("rhythm_assessment", 10, {"rhythm": "vf", "pulse": "absent"}, 3)]
    result = guidance(
        events=events,
        compression_status="held",
        hold_anchor_at=ANCHOR + timedelta(seconds=30),
        now=ANCHOR + timedelta(seconds=40),
    )
    assert result["status"] == "assessment_required"
    assert result["needs_rhythm_assessment"] is True


def test_epinephrine_interval_window_uses_last_effective_administration_time():
    events = [
        event("rhythm_assessment", 1, {"rhythm": "pea", "pulse": "absent"}, 3),
        event("medication_admin", 0, {"title": "Epinephrine", "dose": 1, "units": "mg"}, 4),
    ]
    before = guidance(events=events, now=ANCHOR + timedelta(minutes=2, seconds=59))
    active = guidance(events=events, now=ANCHOR + timedelta(minutes=4))
    elapsed = guidance(events=events, now=ANCHOR + timedelta(minutes=5, seconds=1))
    assert by_id(before, "adult-arrest-epinephrine-interval")["state"] == "before_window"
    assert by_id(active, "adult-arrest-epinephrine-interval")["state"] == "within_window"
    assert by_id(elapsed, "adult-arrest-epinephrine-interval")["state"] == "window_elapsed"


def test_epinephrine_next_step_has_due_and_overdue_boundaries_and_prefill_values():
    assessed = [event("rhythm_assessment", 10, {"rhythm": "pea", "pulse": "absent"}, 3)]
    first_step = next(item for item in guidance(events=assessed)["next_steps"] if item["id"] == "adult-arrest-epinephrine")
    assert first_step["due_at"] == (ANCHOR + timedelta(minutes=3, seconds=10)).isoformat().replace("+00:00", "Z")
    assert first_step["overdue_at"] == (ANCHOR + timedelta(minutes=5, seconds=10)).isoformat().replace("+00:00", "Z")
    assert first_step["dose"] == 1
    assert first_step["units"] == "mg"
    assert first_step["routes"] == ["IV", "IO"]

    with_administration = assessed + [event("medication_admin", 20, {"title": "Epinephrine", "route": "IO"}, 4)]
    repeat = next(item for item in guidance(events=with_administration)["next_steps"] if item["id"] == "adult-arrest-epinephrine")
    assert repeat["due_at"] == (ANCHOR + timedelta(minutes=3, seconds=20)).isoformat().replace("+00:00", "Z")
    assert repeat["overdue_at"] == (ANCHOR + timedelta(minutes=5, seconds=20)).isoformat().replace("+00:00", "Z")


def test_antiarrhythmic_tracks_selected_agent_and_caps_at_two_documented_doses():
    base = _shock_events(4)
    one_dose = base + [event("medication_admin", 5, {"title": "Amiodarone"}, 5)]
    two_doses = one_dose + [event("medication_admin", 6, {"title": "Amiodarone"}, 6)]
    result_one = guidance(events=one_dose)
    result_two = guidance(events=two_doses)
    first_step = next(step for step in result_one["next_steps"] if step["id"] == "adult-arrest-antiarrhythmic")
    assert first_step["dose_number"] == 2
    assert first_step["options"] == {"amiodarone": {"dose": 150, "units": "mg", "range": "150 mg IV/IO", "available": True}}
    assert not any(step["id"] == "adult-arrest-antiarrhythmic" for step in result_two["next_steps"])


def test_mixed_antiarrhythmic_agents_trigger_review_instead_of_switch_suggestion():
    events = [
        event("rhythm_assessment", 1, {"rhythm": "vf", "pulse": "absent"}, 3),
        event("electrical_therapy", 2, {"therapy_type": "defibrillation", "energy_joules": 200}, 4),
        event("electrical_therapy", 3, {"therapy_type": "defibrillation", "energy_joules": 200}, 5),
        event("medication_admin", 4, {"title": "Lidocaine"}, 6),
        event("medication_admin", 5, {"title": "Amiodarone"}, 7),
    ]
    result = guidance(events=events)
    assert by_id(result, "adult-arrest-antiarrhythmic")["state"] == "multiple_agents_documented"


def test_rules_are_pure_and_do_not_modify_or_add_events():
    events = [event("rhythm_assessment", 1, {"rhythm": "vf", "pulse": "absent"}, 3)]
    original = deepcopy(events)
    guidance(events=events)
    assert events == original
