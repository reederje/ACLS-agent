"""Deterministic, advisory protocol guidance for reviewed simulation pathways."""

from datetime import datetime, timedelta, timezone
from typing import Any

ADULT_ARREST_RULESET_VERSION = "2025-AHA-adult-arrest-v1"
ADULT_ARREST_SOURCE = {
    "title": "2025 AHA Adult Cardiac Arrest Algorithm",
    "url": "https://cpr.heart.org/-/media/CPR-Files/CPR-Guidelines-Files/2025-Algorithms/Algorithm-ACLS-CA-250527.pdf?sc_lang=en",
    "source_location": "Adult Cardiac Arrest Algorithm; High-Quality CPR; Shock Energy for Defibrillation; Amiodarone and Lidocaine dosing",
    "population": "adult",
    "guideline_year": 2025,
    "verification_status": "clinician-approved flow; implementation is for synthetic simulation only",
}
HELP_LINKS = {
    "high_quality_cpr": {"title": "High-quality CPR recommendations", "href": "#high-quality-cpr-dialog"},
    "shock": {"title": "Shock recommendations", "href": "#shock-recommendations-dialog"},
}


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    value = _utc(value)
    return value.isoformat().replace("+00:00", "Z") if value else None


def _parse_time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    if not isinstance(value, str):
        return None
    try:
        return _utc(datetime.fromisoformat(value.replace("Z", "+00:00")))
    except ValueError:
        return None


def _medication_name(event: dict[str, Any]) -> str:
    payload = event.get("payload") or {}
    return str(payload.get("title") or payload.get("medication") or "").strip().casefold()


def _base_result(status: str, version: str, summary: str, now: datetime) -> dict[str, Any]:
    return {
        "pathway": "adult_cardiac_arrest",
        "ruleset_version": version,
        "status": status,
        "summary": summary,
        "recommendations": [],
        "next_steps": [],
        "needs_rhythm_assessment": False,
        "help": HELP_LINKS,
        "sources": [ADULT_ARREST_SOURCE],
        "as_of": _iso(now),
    }


def _event_time(event: dict[str, Any]) -> datetime | None:
    return _parse_time(event.get("occurred_at"))


def _latest_event(events: list[dict[str, Any]], event_type: str) -> dict[str, Any] | None:
    matches = [event for event in events if event.get("type") == event_type]
    if not matches:
        return None
    return max(matches, key=lambda event: (_event_time(event) or datetime.min.replace(tzinfo=timezone.utc), event.get("sequence", 0)))


def _is_after(event: dict[str, Any] | None, moment: datetime | None) -> bool:
    occurred = _event_time(event) if event else None
    return bool(occurred and moment and occurred > moment)


def _event_follows(candidate: dict[str, Any], reference: dict[str, Any] | None) -> bool:
    """Compare event order, using sequence for events in the same minute.

    datetime-local inputs traditionally have minute precision. Sequence is the
    deterministic tie-breaker for such same-minute documentation so a shock
    entered after an assessment is not treated as preceding it.
    """
    if reference is None:
        return False
    candidate_time = _event_time(candidate)
    reference_time = _event_time(reference)
    if candidate_time is None or reference_time is None:
        return candidate.get("sequence", 0) > reference.get("sequence", 0)
    if candidate_time > reference_time:
        return True
    same_minute = candidate_time.replace(second=0, microsecond=0) == reference_time.replace(second=0, microsecond=0)
    return same_minute and candidate.get("sequence", 0) > reference.get("sequence", 0)


def _medication_guidance(
    events: list[dict[str, Any]],
    now: datetime,
    antiarrhythmic: bool,
    defibrillation_count: int = 0,
) -> list[dict[str, Any]]:
    recommendations: list[dict[str, Any]] = []
    epinephrine_events = [
        event for event in events
        if event.get("type") == "medication_admin" and "epinephrine" in _medication_name(event)
    ]
    last_epinephrine = max(
        epinephrine_events,
        key=lambda event: _event_time(event) or datetime.min.replace(tzinfo=timezone.utc),
        default=None,
    )
    epi_item: dict[str, Any] = {
        "id": "adult-arrest-epinephrine-interval",
        "kind": "medication_interval",
        "title": "Epinephrine",
        "interval_minutes": {"minimum": 3, "maximum": 5},
    }
    if last_epinephrine and _event_time(last_epinephrine):
        last_time = _event_time(last_epinephrine)
        window_start = last_time + timedelta(minutes=3)
        window_end = last_time + timedelta(minutes=5)
        if now < window_start:
            epi_item.update({
                "state": "before_window",
                "text": f"Repeat interval: 3–5 minutes after the last documented administration. The next window begins at {window_start.strftime('%H:%M:%S UTC')}.",
            })
        elif now <= window_end:
            epi_item.update({"state": "within_window", "text": "The 3–5-minute repeat interval window is active, measured from the last documented administration."})
        else:
            epi_item.update({"state": "window_elapsed", "text": "The 3–5-minute repeat interval from the last documented administration has elapsed."})
        epi_item["last_administration_at"] = _iso(last_time)
        epi_item["next_window_start"] = _iso(window_start)
        epi_item["next_window_end"] = _iso(window_end)
    else:
        epi_item.update({
            "state": "no_administration_documented",
            "text": "Epinephrine is part of this pathway; repeat administrations are at 3–5-minute intervals. No administration is documented in this session.",
        })
    recommendations.append(epi_item)

    if antiarrhythmic and defibrillation_count >= 2:
        antiarrhythmic_events = [
            event for event in events
            if event.get("type") == "medication_admin"
            and ("amiodarone" in _medication_name(event) or "lidocaine" in _medication_name(event))
        ]
        documented_agents = {
            agent for agent in ("amiodarone", "lidocaine")
            if any(agent in _medication_name(event) for event in antiarrhythmic_events)
        }
        if len(documented_agents) > 1:
            recommendations.append({
                "id": "adult-arrest-antiarrhythmic",
                "kind": "conditional_medication",
                "title": "Antiarrhythmic administrations",
                "state": "multiple_agents_documented",
                "maximum_doses": 2,
                "text": "Both amiodarone and lidocaine are documented. This ruleset does not recommend switching or combining agents; clinician review is required.",
            })
            return recommendations
        selected = next(iter(documented_agents), None)
        selected_events = [event for event in antiarrhythmic_events if selected and selected in _medication_name(event)]
        if selected:
            if len(selected_events) < 2:
                recommendations.append({
                    "id": "adult-arrest-antiarrhythmic",
                    "kind": "conditional_medication",
                    "title": selected.title(),
                    "state": "selected_agent",
                    "doses_documented": len(selected_events),
                    "maximum_doses": 2,
                    "text": f"For persistent VF/pulseless VT, the selected agent may be used for up to 2 documented doses ({len(selected_events)} recorded).",
                })
            else:
                recommendations.append({
                    "id": "adult-arrest-antiarrhythmic",
                    "kind": "conditional_medication",
                    "title": selected.title(),
                    "state": "maximum_documented",
                    "doses_documented": len(selected_events),
                    "maximum_doses": 2,
                    "text": "Two doses of the selected antiarrhythmic are documented; this draft provides no further antiarrhythmic suggestion.",
                })
        elif not antiarrhythmic_events:
            recommendations.append({
                "id": "adult-arrest-antiarrhythmic",
                "kind": "conditional_medication",
                "title": "Amiodarone or lidocaine",
                "state": "conditional",
                "maximum_doses": 2,
                "text": "For persistent VF/pulseless VT, amiodarone or lidocaine may be considered, up to 2 doses of the selected agent.",
            })
    return recommendations


def _defibrillation_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        event for event in events
        if event.get("type") == "electrical_therapy"
        and (event.get("payload") or {}).get("therapy_type") == "defibrillation"
    ]


def _antiarrhythmic_step(events: list[dict[str, Any]], weight_kg: float | None) -> dict[str, Any] | None:
    shock_count = len(_defibrillation_events(events))
    medication_events = [
        event for event in events
        if event.get("type") == "medication_admin"
        and any(name in _medication_name(event) for name in ("amiodarone", "lidocaine"))
    ]
    if shock_count < 2 or len(medication_events) >= 2:
        return None

    agents = {
        name for name in ("amiodarone", "lidocaine")
        if any(name in _medication_name(event) for event in medication_events)
    }
    if len(agents) > 1:
        return None
    dose_number = len(medication_events) + 1
    if dose_number == 2 and shock_count < 4:
        return None
    selected_agent = next(iter(agents), None)

    amiodarone_dose = 300 if dose_number == 1 else 150
    lidocaine_multiplier = 1.0 if dose_number == 1 else 0.5
    lidocaine_max_multiplier = 1.5 if dose_number == 1 else 0.75
    lidocaine_default = round(weight_kg * lidocaine_multiplier, 2) if weight_kg else None
    lidocaine_range = (
        f"{weight_kg * lidocaine_multiplier:g}–{weight_kg * lidocaine_max_multiplier:g} mg ({lidocaine_multiplier:g}–{lidocaine_max_multiplier:g} mg/kg)"
        if weight_kg else f"{lidocaine_multiplier:g}–{lidocaine_max_multiplier:g} mg/kg; weight required"
    )
    options = {
        "amiodarone": {
            "dose": amiodarone_dose,
            "units": "mg",
            "range": f"{amiodarone_dose} mg IV/IO",
            "available": True,
        },
        "lidocaine": {
            "dose": lidocaine_default,
            "units": "mg",
            "range": lidocaine_range,
            "available": bool(weight_kg and weight_kg > 0),
        },
    }
    if selected_agent:
        options = {selected_agent: options[selected_agent]}
    dose_ordinal = "first" if dose_number == 1 else "second"
    return {
        "id": "adult-arrest-antiarrhythmic",
        "title": f"Administer {dose_ordinal} antiarrhythmic dose",
        "text": f"{shock_count} defibrillation shocks are documented. Choose amiodarone OR lidocaine for the {dose_ordinal} dose; no more than two doses are offered.",
        "action": "administer_antiarrhythmic",
        "kind": "medication",
        "dose_number": dose_number,
        "no_timer": True,
        "options": options,
        "routes": ["IV", "IO"],
        "source": ADULT_ARREST_SOURCE,
    }


def _scheduled_step(
    *,
    step_id: str,
    title: str,
    text: str,
    action: str,
    due_at: datetime,
    late_at: datetime | None = None,
    kind: str = "action",
) -> dict[str, Any]:
    return {
        "id": step_id,
        "title": title,
        "text": text,
        "action": action,
        "kind": kind,
        "due_at": _iso(due_at),
        "overdue_at": _iso(late_at),
    }


def _epinephrine_step(events: list[dict[str, Any]], now: datetime) -> dict[str, Any] | None:
    administrations = [
        event for event in events
        if event.get("type") == "medication_admin" and "epinephrine" in _medication_name(event)
    ]
    latest = max(
        administrations,
        key=lambda event: _event_time(event) or datetime.min.replace(tzinfo=timezone.utc),
        default=None,
    )
    if latest and _event_time(latest):
        last_time = _event_time(latest)
        due_at = last_time + timedelta(minutes=3)
        overdue_at = last_time + timedelta(minutes=5)
        title = "Repeat epinephrine"
        text = "Repeat interval is 3–5 minutes after the last documented administration."
    else:
        first_pulseless_assessment = min(
            (
                _event_time(event) for event in events
                if event.get("type") == "rhythm_assessment"
                and (event.get("payload") or {}).get("pulse") == "absent"
                and (event.get("payload") or {}).get("rhythm") in {"vf", "vt", "pea", "asystole"}
                and _event_time(event) is not None
            ),
            default=None,
        )
        if first_pulseless_assessment is None:
            return None
        due_at = first_pulseless_assessment + timedelta(minutes=3)
        overdue_at = first_pulseless_assessment + timedelta(minutes=5)
        title = "Epinephrine due"
        text = "With no administration documented, the first reminder window is anchored to the first documented pulseless rhythm: due at 3 minutes and overdue at 5 minutes. Subsequent windows use the last administration time."
    step = _scheduled_step(
        step_id="adult-arrest-epinephrine",
        title=title,
        text=text,
        action="administer_epinephrine",
        due_at=due_at,
        late_at=overdue_at,
        kind="medication",
    )
    step.update({"dose": 1, "units": "mg", "routes": ["IV", "IO"]})
    return step


def adult_cardiac_arrest_guidance(
    *,
    lifecycle: str,
    workflow: str,
    population: str | None,
    weight_kg: float | None,
    compression_status: str,
    started_at: datetime | None,
    compression_anchor_at: datetime | None,
    hold_anchor_at: datetime | None,
    events: list[dict[str, Any]],
    now: datetime,
    ruleset_version: str = ADULT_ARREST_RULESET_VERSION,
) -> dict[str, Any]:
    """Return advisory guidance from documented state only; never writes clinical events."""
    now = _utc(now) or datetime.now(timezone.utc)
    if workflow != "cardiac_arrest" or population != "adult":
        result = _base_result("not_applicable", ruleset_version, "Adult cardiac-arrest guidance is not applicable to this session.", now)
        if lifecycle == "ready":
            is_arrest = workflow == "cardiac_arrest"
            result["next_steps"].append({
                "id": "session-start",
                "title": "Start session",
                "text": "Starting also records compression start." if is_arrest else "Starts elapsed session time only; CPR is not implied.",
                "action": "start",
                "kind": "session",
            })
        return result
    if lifecycle != "active":
        message = "Recommendations are inactive for this session." if lifecycle == "ended" else "Guidance starts when the session is active."
        result = _base_result("inactive", ruleset_version, message, now)
        if lifecycle == "ready":
            result["next_steps"].append({
                "id": "adult-arrest-start",
                "title": "Start the code",
                "text": "Starting the session also records the start of compressions.",
                "action": "start",
                "kind": "session",
            })
        return result

    result = _base_result("active", ruleset_version, "Adult cardiac-arrest guidance is based only on documented session findings.", now)
    latest_assessment = _latest_event(events, "rhythm_assessment")
    assessment_payload = (latest_assessment or {}).get("payload") or {}
    assessment_time = _event_time(latest_assessment) if latest_assessment else None
    cycle_anchor = _utc(compression_anchor_at) or _utc(started_at)

    if assessment_payload.get("pulse") == "present":
        result["status"] = "pulse_present"
        rhythm = assessment_payload.get("rhythm")
        is_rosc = rhythm == "rosc"
        is_vt = rhythm == "vt"
        result["summary"] = (
            "Return of spontaneous circulation is documented." if is_rosc else
            "A pulse is documented with ventricular tachycardia; pulseless-arrest recommendations do not apply." if is_vt else
            "A pulse is documented present; arrest-pathway recommendations are stopped."
        )
        result["recommendations"].append({
            "id": "adult-arrest-pulse-present" if is_rosc else "adult-arrest-vt-with-pulse" if is_vt else "adult-arrest-pulse-present",
            "kind": "status",
            "title": "ROSC documented" if is_rosc else "VT with pulse documented" if is_vt else "Pulse documented present",
            "text": "Confirm and record ROSC to end the arrest session. Post-arrest care is outside this pathway." if is_rosc else "This is not the pulseless-arrest branch. Follow the appropriate clinician-directed pathway; no shockable-arrest recommendation is made here." if is_vt else "Adult cardiac-arrest recommendations stop. Follow clinician direction and document the appropriate session outcome.",
        })
        if is_rosc:
            result["next_steps"].append(_scheduled_step(
                step_id="adult-arrest-rosc",
                title="Confirm and record ROSC",
                text="ROSC was selected. Confirm and record the session outcome.",
                action="rosc",
                due_at=assessment_time or now,
                kind="session",
            ))
        return result

    if compression_status == "held":
        if not _is_after(latest_assessment, _utc(hold_anchor_at)):
            result["status"] = "assessment_required"
            result["summary"] = "Document rhythm and pulse separately before resuming compressions."
            result["needs_rhythm_assessment"] = True
            result["recommendations"].append({
                "id": "adult-arrest-rhythm-pulse-assessment",
                "kind": "assessment",
                "title": "Document rhythm and pulse",
                "text": "Select the observed rhythm. Pulse is implied except for VT, where pulse presence must be recorded. This does not resume compressions or record a treatment.",
            })
            result["next_steps"].append(_scheduled_step(
                step_id="adult-arrest-pulse-check",
                title="Complete rhythm and pulse check",
                text="Select the observed rhythm and pulse for the pause that is already documented.",
                action="pulse_check",
                due_at=_utc(hold_anchor_at) or now,
                kind="assessment",
            ))
            if assessment_payload.get("pulse") == "absent" and assessment_payload.get("rhythm") in {"vf", "vt", "pea", "asystole"}:
                result["recommendations"].extend(_medication_guidance(events, now, antiarrhythmic=False))
                epi_step = _epinephrine_step(events, now)
                if epi_step:
                    result["next_steps"].append(epi_step)
            return result
    elif cycle_anchor and now >= cycle_anchor + timedelta(minutes=2):
        result["status"] = "assessment_required"
        result["summary"] = "The 2-minute rhythm and pulse check is due."
        result["recommendations"].append({
            "id": "adult-arrest-rhythm-pulse-assessment",
            "kind": "cycle_check",
            "title": "2-minute rhythm and pulse check due",
            "text": "If a compression pause actually occurs, document Compressions Held and then record rhythm and pulse. Do not document a pause only because the timer expired.",
        })
        result["next_steps"].append(_scheduled_step(
            step_id="adult-arrest-pulse-check",
            title="Rhythm and pulse check due",
            text="Only document a pause if compressions are actually held.",
            action="pulse_check",
            due_at=cycle_anchor + timedelta(minutes=2),
            late_at=cycle_anchor + timedelta(minutes=2),
            kind="assessment",
        ))
        if assessment_payload.get("pulse") == "absent" and assessment_payload.get("rhythm") in {"vf", "vt", "pea", "asystole"}:
            result["recommendations"].extend(_medication_guidance(events, now, antiarrhythmic=False))
            epi_step = _epinephrine_step(events, now)
            if epi_step:
                result["next_steps"].append(epi_step)
        return result
    elif assessment_time is None:
        result["status"] = "assessment_required"
        result["summary"] = "Document the initial rhythm and pulse assessment."
        result["needs_rhythm_assessment"] = True
        result["recommendations"].append({
            "id": "adult-arrest-rhythm-pulse-assessment",
            "kind": "assessment",
            "title": "Document initial rhythm and pulse",
            "text": "Record the observed rhythm and pulse separately; the app will not infer either finding.",
        })
        result["next_steps"].append(_scheduled_step(
            step_id="adult-arrest-pulse-check",
            title="Record initial rhythm and pulse",
            text="Document what was observed; do not infer rhythm or pulse.",
            action="pulse_check",
            due_at=_utc(started_at) or now,
            kind="assessment",
        ))
        return result

    pulse = assessment_payload.get("pulse")
    rhythm = assessment_payload.get("rhythm")
    if rhythm in {"vf", "vt"} and pulse == "absent":
        branch = "shockable"
    elif rhythm in {"pea", "asystole"}:
        branch = "nonshockable"
    elif rhythm == "vt" and pulse not in {"present", "absent"}:
        result["status"] = "assessment_required"
        result["summary"] = "Document pulse presence or absence for ventricular tachycardia."
        result["needs_rhythm_assessment"] = True
        result["recommendations"].append({
            "id": "adult-arrest-pulse-unknown",
            "kind": "missing_input",
            "title": "VT pulse status needed",
            "text": "For VT, select whether a pulse is present or absent before a branch can be chosen.",
        })
        return result
    else:
        result["status"] = "assessment_required"
        result["summary"] = "The documented rhythm does not select a supported adult-arrest branch."
        result["needs_rhythm_assessment"] = True
        result["recommendations"].append({
            "id": "adult-arrest-rhythm-unknown",
            "kind": "missing_input",
            "title": "Rhythm branch not established",
            "text": "Select VF, VT, PEA, asystole, or ROSC. For VT, document whether the pulse is present or absent.",
        })
        result["next_steps"].append(_scheduled_step(
            step_id="adult-arrest-pulse-check",
            title="Complete rhythm and pulse check",
            text="The documented findings do not select a supported arrest branch.",
            action="pulse_check",
            due_at=assessment_time or now,
            kind="assessment",
        ))
        return result

    if compression_status == "held" and pulse == "absent":
        result["next_steps"].append(_scheduled_step(
            step_id="adult-arrest-resume-cpr",
            title="Resume compressions",
            text="Immediately resume compressions after the pulse check.",
            action="resume",
            due_at=now,
            kind="cpr",
        ))

    if branch == "shockable":
        shock_after_assessment = any(
            event.get("type") == "electrical_therapy"
            and (event.get("payload") or {}).get("therapy_type") == "defibrillation"
            and _event_follows(event, latest_assessment)
            for event in events
        )
        if not shock_after_assessment:
            result["summary"] = "A shockable rhythm is documented with absent pulses: a single shock is advised; then resume CPR."
            result["recommendations"].append({
                "id": "adult-arrest-shock",
                "kind": "electrical_therapy",
                "title": "Shock advised",
                "text": "A shockable rhythm is documented with absent pulses. Recommend one defibrillation shock, then immediately resume CPR for 2 minutes.",
                "help": HELP_LINKS["shock"],
            })
            result["next_steps"].append(_scheduled_step(
                step_id="adult-arrest-shock",
                title="Record defibrillation",
                text="Document the shock actually delivered; compressions are not restarted automatically.",
                action="record_shock",
                due_at=assessment_time or now,
                late_at=assessment_time or now,
                kind="electrical_therapy",
            ))
        else:
            result["summary"] = "A shock was documented after the previous assessment; continue or resume CPR for the next 2-minute cycle."
            result["recommendations"].append({
                "id": "adult-arrest-resume-cpr",
                "kind": "cpr",
                "title": "Continue or resume CPR",
                "text": "A defibrillation event was documented after the previous rhythm assessment. Continue or resume CPR for 2 minutes",
                "help": HELP_LINKS["high_quality_cpr"],
            })
        defibrillation_count = len(_defibrillation_events(events))
        result["recommendations"].extend(_medication_guidance(
            events,
            now,
            antiarrhythmic=True,
            defibrillation_count=defibrillation_count,
        ))
        antiarrhythmic_step = _antiarrhythmic_step(events, weight_kg)
        if antiarrhythmic_step:
            result["next_steps"].append(antiarrhythmic_step)
        epi_step = _epinephrine_step(events, now)
        if epi_step:
            result["next_steps"].append(epi_step)
    else:
        is_held = compression_status == "held"
        result["summary"] = (
            "Asystole or pulseless electrical activity is documented: resume compressions when actually resumed and follow epinephrine interval guidance."
            if is_held else
            "Asystole or pulseless electrical activity is documented: continue CPR and follow the epinephrine interval guidance."
        )
        result["recommendations"].append({
            "id": "adult-arrest-nonshockable-cpr",
            "kind": "cpr",
            "title": "Nonshockable pathway — resume CPR" if is_held else "Nonshockable pathway — continue CPR",
            "text": (
                "Compressions are documented as held. Resume only when the team actually resumes; the app will not restart compressions or the timer automatically."
                if is_held else
                "Continue CPR for the next 2-minute cycle, then document rhythm and pulse. The app does not pause or restart compressions automatically."
            ),
            "help": HELP_LINKS["high_quality_cpr"],
        })
        result["recommendations"].extend(_medication_guidance(events, now, antiarrhythmic=False))
        epi_step = _epinephrine_step(events, now)
        if epi_step:
            result["next_steps"].append(epi_step)

    if compression_status == "running" and cycle_anchor:
        next_check_at = cycle_anchor + timedelta(minutes=2)
        if now < next_check_at:
            result["next_steps"].append(_scheduled_step(
                step_id="adult-arrest-next-pulse-check",
                title="Next rhythm and pulse check",
                text="A rhythm and pulse check is due at the end of this 2-minute compression cycle.",
                action="pulse_check",
                due_at=next_check_at,
                late_at=next_check_at,
                kind="assessment",
            ))

    return result
