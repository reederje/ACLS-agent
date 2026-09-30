# Resuscitation Application — Clinical Prototype Specification

Version: 1.0  
Prepared: September 23, 2026  
Audience: An agentic coding tool implementing the application

## 1. Build objective

Build a working, desktop-oriented web application that assists a documenting nurse during simulated adult and pediatric resuscitations. Combine deterministic ACLS/PALS guidance, clearly visible timers, fast intervention documentation, synthetic patient context, Azure OpenAI summaries, and a live event log. Provide a separate read-only status board for a large team monitor and generate a copyable, timestamped note after the session.

This is a clinical prototype for testing with synthetic data. Deliver an integrated application, not just mockups or a design document. Use Python and Flask, and support deployment to Azure App Service. Keep a small, persistent “Simulation — synthetic patient” indicator visible.

The long-term concept is an EHR-embedded SMART on FHIR application. That integration is explicitly deferred. Preserve a clean patient-data interface so a future FHIR adapter can replace synthetic records without rewriting the resuscitation workflow.

## 2. Confirmed scope and implementation defaults

### 2.1 Included in this version

- Adult ACLS and pediatric PALS cardiac arrest workflows.
- Symptomatic bradycardia and tachyarrhythmias with a pulse, including SVT, within the applicable adult/pediatric algorithms.
- Manual rhythm, pulse, stability, and intervention entry; no monitor integration.
- A nurse-operated desktop workspace with prominent action buttons and timers.
- A separately authenticated, read-only status board showing the same session.
- Ten synthetic patient cases, including adults and children.
- Six months of recent patient context, plus ongoing problems, medications, allergies, weight, and code status even when originally documented earlier.
- Suggested medication doses/routes with editable administration details.
- Prominent, correctable pediatric weight, including manually entered estimated weight.
- Azure OpenAI history summaries and ranked reversible-cause hypotheses with supporting findings.
- Persistent session events, correction/deletion audit history, and a copyable final note.

### 2.2 Explicit exclusions

- FHIR connectivity, EHR launch, SMART authorization, EHR write-back, and real patient data.
- Neonatal resuscitation; standalone respiratory-arrest, pediatric-shock, acute-coronary-syndrome, and stroke workflows.
- Post-ROSC management: clicking ROSC ends the session in this version.
- Re-arrest within a completed session.
- Automatic rhythm interpretation, automatic event capture, voice entry, and device control.
- Medication ordering or requested-versus-given tracking. Only actual administrations are recorded.
- Institution-specific protocols, autonomous treatment decisions, and LLM-generated medication dosing.
- Multiple concurrent recording users for the same session, mobile-first design, and offline operation.

Airway interventions remain documentable during included workflows. Underlying causes such as pulmonary embolism or hypovolemia can appear in the patient context and reversible-cause assessment without adding separate disease-treatment workflows.

### 2.3 Defaults selected for implementation

These choices fill gaps in the requirements; they are not additional user mandates:

| Area | Default |
| --- | --- |
| Patient fixtures | Version-controlled JSON, one file per synthetic patient |
| Runtime storage | SQLAlchemy; SQLite for local development/testing; PostgreSQL through `DATABASE_URL` for the Azure deployment |
| Frontend | Flask/Jinja templates, locally bundled Bootstrap, and focused JavaScript modules; no SPA framework required |
| Synchronization | Authenticated polling every second; local rendering of elapsed time between polls |
| Recorder model | One active recording browser per session; multiple read-only viewers |
| LLM refresh | Automatically on patient selection; manual refresh thereafter; no request for every event |
| Sound | Optional, off by default; visual cues always sufficient |
| Other session endings | “End session” with a reason such as resuscitation terminated, arrhythmia resolved, or simulation stopped |
| Guideline baseline | Versioned 2025 AHA adult and pediatric algorithms, with referenced rules and documented clinical review status |

Do not provision paid Azure resources automatically. Supply deployment instructions and configuration templates.

## 3. Users, authentication, and permissions

Use simple username/password authentication with two roles and distinct credentials:

| Capability | Recorder | Viewer |
| --- | --- | --- |
| Select a synthetic patient and create a session | Yes | No |
| Start/end a session and record interventions | Yes | No |
| Correct weight or events; delete erroneous events | Yes | No |
| Trigger an AI refresh | Yes | No |
| View session status and patient context | Yes | Yes |
| View the final note | Yes | Yes |
| Inspect correction/deletion history | Yes | No |

Implement password hashing, server-enforced role checks, session cookies, CSRF protection for writes, and basic login throttling. Configure demo accounts through a setup command or deployment settings; do not commit usable passwords or API secrets. A viewer submitting a write request directly must receive an authorization error.

Use a per-session recording lease so a second tab or browser cannot silently become another writer. An explicit recorder takeover invalidates the prior lease and is audited. Concurrent sessions for different patients may exist.

## 4. Core user journey

1. Recorder signs in and sees a synthetic-patient picker and existing sessions.
2. Selecting a patient opens a preparation view with demographics, code status, weight, source data, and an asynchronously generated AI summary.
3. Recorder confirms adult versus pediatric mode and chooses cardiac arrest, bradycardia with a pulse, or tachycardia with a pulse. Suggested mode comes from the fixture; do not silently choose based on a simplistic age cutoff.
4. For pediatric patients, the nurse confirms or changes weight and whether it is measured, historical, caregiver-reported, or estimated.
5. “Start code” starts the session clock. In cardiac arrest mode its adjacent label explicitly states that this also records the start of compressions. In a pulse-present workflow, the session clock starts without recording CPR or activating a compression-cycle countdown.
6. The nurse documents actions through large buttons and a categorized intervention drawer. The log and status board update promptly after successful saves.
7. In arrest mode, a countdown reaching zero shows “Pulse check due”; only the nurse clicking “Compressions held” records an actual pause.
8. During the pause, the nurse selects the rhythm and pulse findings. “Compressions resumed” explicitly records resumption and begins the next cycle when appropriate.
9. Clicking ROSC records ROSC and ends the session. Alternatively, “End session” records another chosen outcome/reason.
10. The app displays a deterministic final summary and a copyable note. The recorder can correct documentation afterward; corrections produce a new note revision and do not resume the session.

## 5. Desktop workspace and status board

### 5.1 Recording workspace

Optimize for approximately 1440 × 900, remaining usable at 1280 × 720 and at 200% browser zoom. Use this visual hierarchy:

1. **Persistent top strip:** synthetic patient name/ID, age, protocol mode, weight, allergy indicator, code status, session state, and connection/save status. Pediatric weight must be conspicuous.
2. **Primary action region:** large total elapsed time, compression-cycle countdown or hold duration, current documented rhythm/pulse status, and next applicable actions/medications.
3. **Intervention drawer:** large clickable tiles grouped into medications, electrical therapy, airway/breathing, access/procedures, assessments, and other/free text. Context-sensitive favorites appear first without hiding the full catalog.
4. **Live event log:** continuously visible, independently scrollable, with readable timestamps, recent events, and correction controls. New events must not force a user away from an older event they are reviewing.
5. **Right context pane:** approximately one quarter of the available width, containing a brief AI narrative, top reversible-cause hypotheses, and expandable source findings. It can collapse to give actions more space.

Keep timers and core actions visible while other regions scroll. Use descriptive text plus color/icons; never communicate urgency or rhythm category by color alone. Support keyboard operation, visible focus, readable contrast, and large click targets. Avoid modal alerts on every timer tick. Reserve confirmation prompts for actual administration details, session termination, and consequential corrections.

### 5.2 Read-only status board

Provide a dedicated route suitable for a 1080p wall display. Emphasize patient identity, protocol mode, weight, elapsed time, compression state, current rhythm, next applicable actions, last medication administrations, and recent events. Show a compact reversible-cause list if space permits. Omit editing controls and dense chart text.

Show “Read only,” last synchronization time, and a prominent stale-data indicator if no successful update arrives for five seconds. Locally advancing timers during an outage must be labeled as based on the last synchronized state. Reconcile immediately after reconnecting.

## 6. Clinical guidance engine

Implement a deterministic, testable rules engine independent of the LLM and UI. Its inputs include protocol mode, workflow, pulse/stability findings, rhythm characteristics, compression state, weight, effective intervention history, and current time. Its output consists of applicable actions, medication suggestions, due windows, missing inputs, and source references.

Use the published [2025 AHA algorithm collection](https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/algorithms), [adult advanced life support guidance](https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-advanced-life-support), and [pediatric advanced life support guidance](https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/pediatric-advanced-life-support). These references establish the clinical baseline; this specification is not a complete dosing reference.

The coding agent must transcribe and verify the applicable branches and numeric parameters from those primary references rather than inventing doses or using model memory. Maintain a protocol coverage matrix identifying implemented branches, source section/algorithm, version, and review status. Do not label an unfinished branch as supported or claim clinician validation that has not occurred.

Store medication doses, routes, repeat intervals, maximums, energy guidance, and prerequisites in versioned configuration or clearly separated rule modules. Each rule needs a stable ID, population, indication, source URL, source location, guideline year, and verification status. Pin the rule version for a session so a deployment cannot silently change its active protocol.

Support separate adult and pediatric arrest, bradycardia-with-pulse, and tachyarrhythmia-with-pulse pathways. Pulse-present guidance must consider required findings such as heart rate, stability/perfusion, QRS width, and regularity rather than rhythm name alone. Unknown findings must remain unknown and prompt for relevant input.

Differentiate defibrillation from synchronized cardioversion and pacing. Do not infer that every tachycardia should receive the same intervention. Maintain a “record other intervention” path for documenting what actually happened even when it differs from a suggestion; label the deviation rather than altering the record.

Medication recommendations must reflect actual administrations, route, dose sequence, and relevant intervals. A recommendation or an expired timer must never create an administration. A due window should remain a window if the protocol specifies one, rather than implying a single mandatory instant. Where guidance depends on equipment settings or missing clinical information, display that dependency rather than fabricate a universal value.

The app may offer recommendations but never selects a rhythm, administers medication, delivers a shock, or decides to terminate resuscitation. Clinical-content review is required before any consideration of live patient use; this prototype's testing remains synthetic.

## 7. Session states, rhythm checks, and timers

Track lifecycle separately from workflow:

- Lifecycle: `ready`, `active`, `ended`.
- Workflow: `cardiac_arrest`, `bradycardia_with_pulse`, `tachycardia_with_pulse`.
- Compression status: `not_started`, `running`, `held`, `stopped`.
- Rhythm assessment: structured rhythm plus independently documented pulse findings, assessment time, and relevant characteristics.

| Action/condition | Required behavior |
| --- | --- |
| Start code in arrest mode | Persist session start and explicit compression-start documentation atomically; start elapsed and cycle timers |
| Start code in pulse-present mode | Start elapsed timer only; do not imply compressions |
| Compression countdown expires | Display “Pulse check due” and overdue duration; compression status stays running |
| Compressions held | Record actual hold time; switch countdown display to pause duration; request rhythm/pulse assessment |
| Rhythm selected | Save the assessment and update guidance; do not automatically resume compressions |
| Compressions resumed | Save actual resumption time; reset the cycle countdown from that time |
| Shock recorded | Save electrical therapy; do not manufacture a rhythm change or compression resumption |
| Pulse-present patient deteriorates | Explicit “Cardiac arrest / start compressions” transition enters the arrest workflow within the still-active session |
| Pediatric pulse-present workflow requires CPR | Provide an explicit CPR-start action when the verified PALS branch calls for it; do not equate all CPR with pulseless arrest |
| ROSC | Record ROSC, stop timers and guidance, and end session immediately |
| End session | Record reason, stop timers and guidance, and end session |

Offer clear arrest rhythm choices such as VF, pulseless VT, asystole, and organized rhythm with a separate pulse assessment. PEA is not inferred from an organized tracing alone. Provide an “Unable to determine” assessment option so incomplete documentation does not prevent recording resumed compressions. An explicit assessment selection is still required in the normal hold/check/resume flow. Do not make documentation friction imply that clinical actions should be delayed.

Use the verified protocol compression-cycle interval; the conventional arrest cycle is approximately two minutes, as shown in the referenced AHA algorithms. The cycle measures elapsed time from explicitly documented start/resumption. Opening a drawer, giving medication, or recording a shock must not reset it.

Store authoritative UTC timestamps on the server. Return server time and timer anchors with each state response; use a monotonic client clock between synchronizations. Derive timers from anchors instead of saving a decrementing integer. Reloading a page or restarting the application must reconstruct the same session state.

Timers include total session duration, current compression cycle, current pause duration, and applicable medication elapsed/due information. The session clock continues during compression holds. Use actual administration times for medication intervals. Corrections must recalculate affected derived information.

For retrospective state-event corrections, validate temporal ordering and preview any effect on current timers/state. Require a coherent correction of dependent transitions rather than silently accepting an impossible sequence. A late medication entry may still be valid even if the nurse has already entered a later rhythm event.

## 8. Intervention entry and pediatric weight

### 8.1 Medication administration

Clicking a medication opens a compact prompt with medication, suggested dose and units, route dropdown, and administration time defaulting to now. Provide common protocol-specific dose options plus a custom numeric dose entry. Dose and route remain editable. Include an optional note and an explicit “Record given” action; canceling saves nothing.

Record exact administration dose/units, route, event time, recorder identity, and relevant protocol/weight snapshot. Use repeat-click protection and a client-generated idempotency key so retries cannot create duplicate administrations.

The catalog should include medications needed across the included algorithms, such as epinephrine, amiodarone, lidocaine, atropine, and adenosine, plus applicable infusions and selected indication-specific medications. Verify the final catalog and parameters against the chosen sources. Separate routine algorithm recommendations from medications that require a particular indication. Include “Other medication” for documentation.

Capture infusions distinctly from boluses: rate, rate units, start/change/stop times, and concentration when needed. Do not combine incompatible units in cumulative totals. Do not present a volume in mL without an explicit validated concentration; avoid ambiguous ratio-only concentration labels.

### 8.2 Pediatric weight

- Display kilograms prominently throughout recording and on the status board.
- Accept a corrected weight and a provenance choice: measured, historical, caregiver-reported, or estimated.
- For an estimate, require manual kg entry and an optional method/source note. Do not invent an age-to-weight formula in this version.
- Mark estimated weight wherever a weight-dependent suggestion is shown.
- If weight is missing, show non-weight-dependent guidance and permit session/event documentation, but withhold calculated weight-based doses and energies until a valid weight is supplied.
- Show the calculation basis, final suggested dose, and applied maximum when applicable; apply configured rounding and units consistently.
- Audit every weight change. Recalculate future suggestions and invalidate an already-open stale administration prompt; retain the original weight/dose snapshot on previous administrations.
- Validate nonnumeric, zero, and negative inputs; request confirmation for implausible values rather than silently coercing them.

### 8.3 Other intervention categories

| Category | Minimum documentation |
| --- | --- |
| Electrical therapy | Defibrillation versus synchronized cardioversion, delivered energy in joules, time, optional notes; pacing settings captured separately |
| Airway/breathing | Bag-mask ventilation, airway placement/attempt, device, attempt outcome, confirmation method where relevant, time |
| Access/procedures | IV/IO access and other procedures, site/details, time |
| Assessments | Pulse/rhythm checks, vital signs, point-of-care findings, optional glucose/ETCO2 values with units, time |
| Other | Free-text event and editable occurrence time |

All such entries describe documented actions/findings, not automatic physiological changes.

## 9. Synthetic patient records and six-month context

Create ten coherent JSON fixtures with a shared validated schema. Use clearly fictional identifiers/names and no copied real records. Each fixture defines a scenario reference time and relative event offsets; resolve offsets against a session anchor so fixtures do not become obsolete as calendar dates advance.

Required domains are demographics, encounter history, active and chronic problems, medications with status, allergies/reactions, weight/provenance, code status/provenance, vitals, laboratory results with units/reference ranges, procedures, imaging reports, ECG reports, and clinical notes. Empty or unavailable domains must be explicitly represented, not silently interpreted as normal.

Assign every clinical finding a stable source ID and timestamps. Distinguish when it was observed/performed from when the result became available. Freeze a patient-context snapshot for each session so later fixture edits cannot change its history or evidence references.

“Six months” means six calendar months before the session reference time, inclusive through that time. Use that window for recent encounters, results, reports, and procedures. Retain ongoing problems, active medications, allergies, latest applicable weight, and latest code status regardless of original entry date; clearly label their age. Do not leak future results into the snapshot. Label old labs as historical, not current arrest measurements.

Code status must show source and date, distinguish unknown from full code, and display any conflicting records. A documented limitation should be prominent and require acknowledgement before starting the synthetic scenario; acknowledgement is logged. The software does not resolve clinical authority or override code status.

### 9.1 Required ten-case matrix

The following are authored simulation scenarios, not diagnoses for real patients. The weights are fixture values. Include realistic distractors, incomplete data, medications/allergies, and multiple dated records in each case.

| ID | Patient / mode | Presentation and chart content to author | Main behavior exercised |
| --- | --- | --- | --- |
| SYN-A01 | Adult, 64 years, 86 kg | VF arrest; coronary disease, recent chest discomfort, a recent ECG report, and an earlier cardiac admission | Shockable adult workflow; coronary-thrombosis hypothesis tied to evidence |
| SYN-A02 | Adult, 58 years, 74 kg | PEA arrest; dialysis history, missed-treatment note, and a recent elevated potassium result with a clear timestamp | Nonshockable workflow; electrolyte hypothesis; historical-versus-current evidence |
| SYN-A03 | Adult, 47 years, 92 kg | PEA arrest; recent surgery, immobilization, and prior venous thromboembolism | Pulmonary-thrombosis hypothesis without falsely claiming confirmation |
| SYN-A04 | Adult, 76 years, 68 kg | Symptomatic bradycardia with pulse; beta-blocker exposure, renal dysfunction, and prior conduction disease | Bradycardia inputs; medication context; pacing/infusion documentation |
| SYN-A05 | Adult, 35 years, 63 kg | Regular narrow-complex tachycardia with pulse and documented symptoms | Adult SVT workflow, stability assessment, medication/cardioversion documentation |
| SYN-P01 | Child, 4 years, 16 kg | PEA arrest following severe respiratory illness with recent oxygenation findings | Pediatric arrest; hypoxia hypothesis; airway documentation |
| SYN-P02 | Child, 10 years, 32 kg | VF arrest; cardiomyopathy and recent ECG abnormalities | Pediatric shock/dose calculations and maximums |
| SYN-P03 | Infant, 8 months, 8 kg | Bradycardia with pulse and poor-perfusion findings in the setting of respiratory illness | Pediatric bradycardia and explicit CPR transition when indicated; no neonatal workflow |
| SYN-P04 | Child, 6 years, 21 kg | Regular narrow-complex tachycardia with pulse and prior SVT encounters | Pediatric tachycardia branch and weight-dependent medication entry |
| SYN-P05 | Child, 3 years, estimated 14 kg | Asystolic arrest; prolonged vomiting/diarrhea, limited recent records, and a stale prior weight | Estimated-weight correction; hypovolemia/acidosis hypotheses; uncertainty handling |

At least one case must contain an explicit medication allergy, one conflicting or limited code-status record, and one unavailable imaging or ECG domain. Keep expected hypotheses and test-only scenario explanations in a separate manifest excluded from all LLM inputs; otherwise the model would merely repeat the answer key.

## 10. Azure OpenAI summaries and reversible causes

### 10.1 Outputs and triggers

On patient selection, request a succinct history narrative (target 100–150 words) covering relevant medical history, current medications, and recent hospitalizations. Also request a ranked reversible-cause assessment based on the available chart evidence. A manual refresh can incorporate newly documented findings from the active session. Do not call the model for every click or timer update.

For a pulse-present session, label the list “Potential reversible contributors” and do not claim that cardiac arrest occurred. For an arrest session, label it “Possible reversible causes — Hs and Ts.” Build the allowed cause vocabulary from the applicable adult/pediatric protocol, preserving population-specific distinctions. Do not impose the adult list on PALS if the reference differs.

Each ranked item must contain cause ID/name, a short rationale, supporting source IDs with dates and findings, contradicting findings if present, missing information, and a qualitative evidence label such as supported, possible, or insufficient data. Show up to three leading hypotheses initially, with expansion to the remaining protocol causes. Do not invent percentage probabilities or a forced ranking when evidence is inadequate.

The LLM summarizes and proposes hypotheses only. It must not supply medication doses, alter protocol rules, prescribe interventions, establish a confirmed cause, or record code events. The deterministic engine continues working if the LLM is slow or unavailable.

### 10.2 Integration contract

Use a server-side provider interface with `AzureOpenAIProvider` and a clearly labeled deterministic `MockSummaryProvider`. Configure endpoint/base URL, deployment name, authentication, and timeout from environment variables. Verify API/deployment compatibility against [Microsoft's Azure OpenAI API documentation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses); do not hard-code a model name or assume every deployment supports identical features.

Send normalized context and stable source IDs, with explicit instructions to use only supplied evidence. Treat chart/report text as data, not executable instructions. Require structured JSON and validate it before display. Reject unknown source IDs, nonexistent causes, invalid shapes, and outputs containing unsupported clinical instructions. Validation cannot prove clinical correctness; retain clear AI attribution and accessible source evidence.

The response contract should include `schema_version`, `narrative`, `narrative_source_ids`, `ranked_causes`, `limitations`, and `insufficient_data`. Persist context hash, session revision, generation time, deployment identifier, prompt version, and validation status. Do not expose secrets or send viewer credentials.

Make the request asynchronously from the browser so it cannot block the workspace. The server must retain capacity to process event writes while awaiting Azure OpenAI. Use bounded timeouts/retries and prevent duplicate concurrent requests for the same context. On failure, show the last valid result with its age, or “Summary unavailable,” while keeping source records accessible.

Do not silently replace a failed live request with a mock narrative presented as AI output. Mock mode must be visibly labeled. Reject late responses belonging to a different patient/context. Mark results stale when their underlying findings change; refreshing is an explicit action after initial generation.

## 11. Event log, corrections, and final note

### 11.1 Event representation

Each event requires a UUID, session ID, type, structured payload, occurrence time, server-recorded time, recorder account, server sequence, idempotency key, and applicable protocol/weight snapshot. Preserve both occurrence and entry time so retrospective documentation is clear. Display occurrence time with seconds and a labeled local time zone; store UTC internally.

Order the clinical timeline by occurrence time with server sequence as a deterministic tie-breaker. Use transactional writes and session revision checks. Guidance, counters, and the final note must use the same effective-event projection.

### 11.2 Edit/delete behavior

“Delete” means exclude the event from the effective clinical timeline while retaining the original record and an append-only tombstone/audit entry. Require a short reason. Edits similarly preserve original values, replacements, author, time, and reason. Provide a recorder-only history view, and allow an erroneous deletion to be corrected without erasing history.

After a medication or shock correction, recalculate effective counters, relevant reminders, and the note. Never retain a deleted administration as if it still happened. If changing a compression/rhythm event would make the state sequence impossible, show affected transitions and require a consistent correction. Preserve actual historical guidance snapshots rather than rewriting what the user originally saw.

Completed sessions remain ended after documentation corrections. A mistaken ROSC/end entry can be corrected in the record and the outcome revised, but does not create a re-arrest or silently restart timers. Track operational closure separately from the corrected clinical outcome where needed.

### 11.3 Copyable code note

Generate the official prototype note deterministically from effective structured data, without an LLM dependency. Include:

- Synthetic patient identifier, protocol mode/version, session ID, recorder, and relevant weight/provenance.
- Start/end time, time zone, duration, and documented end outcome.
- Initial documented rhythm/pulse status and chronological subsequent assessments.
- Compression starts/holds/resumptions, administered medications with doses/routes, electrical therapy with energies/modes, airway/procedure events, and free text.
- ROSC time when actually documented; otherwise do not imply ROSC or death.
- Separate totals where meaningful, such as defibrillation count and medication totals with compatible units; keep cardioversion counts distinct.
- Note generation time and revision; indication that documentation was amended if applicable.

Do not turn missing entries into claims that an action did not occur. Do not assert CPR quality, actual drug delivery, or confirmed arrest etiology beyond what was documented. Keep AI hypotheses outside the factual event note by default; allow a separately labeled optional context appendix.

Provide “Copy note” with success feedback and a selectable-text fallback if the browser clipboard API is unavailable. Keep plain-text formatting readable when pasted into an EHR. Viewers see the completed status/summary without gaining write access.

## 12. Architecture and data model

Use a Flask application factory and blueprints/services separating authentication, patient data, sessions/events, protocols, AI, and summary generation. The authoritative clinical state resides on the server; the browser presents it and submits explicit actions.

Suggested persisted entities:

| Entity | Key contents |
| --- | --- |
| User | Username, password hash, role, active flag |
| Session | Patient snapshot/hash, protocol/version, lifecycle/workflow, anchors, revision, owner/lease, outcome |
| Event | Structured action, occurrence/entry timestamps, idempotency key, sequence, original payload |
| EventRevision/AuditEntry | Correction/tombstone, old/new values, reason, actor, time |
| WeightRevision | Kg, source, source date, correction history |
| AIResult | Validated output, evidence/context hash, generation metadata, status |
| NoteRevision | Generated text, effective-event revision, generation time |

Patient-data abstraction: `list_patients()`, `get_patient_context(patient_id, as_of, lookback_months=6)`, and `get_source_record(source_id, snapshot_id)`. Implement only `JsonPatientRepository`; do not add a nonfunctional FHIR adapter.

Protocol abstraction: `evaluate(session_state, effective_events, patient_context, now)` returns structured recommendations and missing inputs. Keep database writes and external model calls out of this evaluator so behavior can be tested with a fake clock.

## 13. Suggested routes and API behavior

Exact route names can change, but provide equivalent capabilities:

| Route | Purpose |
| --- | --- |
| `GET/POST /login`, `POST /logout` | Authentication |
| `GET /patients` | Recorder patient picker |
| `POST /api/sessions` | Create a session from a synthetic patient |
| `GET /sessions/<id>` | Recording workspace |
| `GET /board/<id>` | Read-only display |
| `GET /api/sessions/<id>/state` | Snapshot, server time, anchors, recommendations, revision |
| `POST /api/sessions/<id>/actions` | Start/hold/resume/rhythm/ROSC/end transitions |
| `POST /api/sessions/<id>/events` | Record intervention/free-text event |
| `PATCH/DELETE /api/sessions/<id>/events/<event_id>` | Audited correction or soft deletion |
| `PATCH /api/sessions/<id>/weight` | Audited weight correction |
| `GET /api/sessions/<id>/audit` | Recorder-only history |
| `POST /api/sessions/<id>/ai-refresh` | Recorder-only summary refresh |
| `GET /api/sessions/<id>/note` | Deterministic note/revision |
| `GET /healthz` | Minimal operational health response |

All write endpoints must enforce role, recording lease where relevant, schema validation, idempotency, and expected session revision. Return the committed revision/state on success. Handle stale writes with a clear conflict response; do not silently overwrite another update.

Never display a failed write as saved. Keep unsaved form values in memory with a visible retry option, but do not implement a hidden offline event queue. Retrying uses the original idempotency key. Avoid patient or event content in application diagnostic logs.

## 14. Azure deployment and configuration

Host on Azure App Service for Linux using a supported Python runtime and Gunicorn. Follow [Microsoft's Python App Service deployment guidance](https://learn.microsoft.com/en-us/azure/app-service/quickstart-python). Keep dependencies pinned and bundle browser assets locally so the workspace is not dependent on public CDNs.

Use SQLite for a zero-service local demo. For the Azure deployment, the default is PostgreSQL configured through `DATABASE_URL`, allowing durable event storage outside application instances. This is an implementation choice to avoid relying on a local SQLite file's lifecycle or shared-filesystem locking. If documenting an optional Azure SQLite deployment, constrain it to a tested single-instance configuration, explicitly validate locking and restart persistence, and do not claim that enabling persistent storage alone makes SQLite safe for scale-out. See [App Service storage behavior](https://learn.microsoft.com/en-us/azure/app-service/configure-custom-container#use-persistent-shared-storage).

Use the database for state coordination; process memory may cache expendable data but cannot be authoritative. Provide migrations, a fixture validation/seed command, and an account-creation command. Restarts must preserve users, sessions, events, audit entries, and notes.

Document these settings in `.env.example` without secrets: `APP_ENV`, `SECRET_KEY`, `DATABASE_URL`, `DISPLAY_TIMEZONE`, `AI_PROVIDER`, `AZURE_OPENAI_BASE_URL` or equivalent endpoint, `AZURE_OPENAI_DEPLOYMENT`, Azure authentication settings, `AI_TIMEOUT_SECONDS`, and any protocol/fixture paths. Document any API-version setting only if the selected Azure client requires one.

Support managed identity where compatible with the selected Azure authentication approach, or an application-setting API key for the prototype. Require HTTPS in deployment, secure cookies, same-origin APIs, escaped free-text rendering, and no debug server in Azure. Keep integration configuration out of the clinical workflow UI.

## 15. Acceptance criteria and meaningful tests

Automate critical state, calculation, authorization, and persistence behavior. Use a fake clock and deterministic fixtures; do not make normal tests depend on live Azure OpenAI.

| ID | Scenario | Pass condition |
| --- | --- | --- |
| AC-01 | Recorder/viewer login | Both roles can view allowed pages; viewer writes fail server-side |
| AC-02 | Patient data | Exactly ten valid cases; six-calendar-month filtering and ongoing-condition exceptions work; future data is excluded |
| AC-03 | Arrest start | One action creates one start, one compression-start record, and correct timer anchors |
| AC-04 | Countdown expiry | “Pulse check due” appears; no hold/rhythm/medication event is created |
| AC-05 | Hold/check/resume | Each is explicit; rhythm entry does not restart CPR; resume starts a new cycle |
| AC-06 | Pulse-present workflow | No automatic CPR timer; relevant stability/rhythm inputs change the applicable branch |
| AC-07 | Protocol fidelity | Source-derived golden cases cover adult/pediatric shockable, nonshockable, bradycardia, and tachycardia branches, dose limits, timing, and missing inputs |
| AC-08 | Medication save | Editable dose/route/time saved exactly once; canceled prompt saves nothing; backdated valid entry adjusts interval calculations |
| AC-09 | Pediatric weight | Missing weight withholds calculations; estimated weight is labeled; changes affect future suggestions and preserve historical snapshots |
| AC-10 | Electrical therapy | Defibrillation and cardioversion remain distinct; recording either does not fabricate CPR resumption |
| AC-11 | Corrections | Deleted/edited events remain auditable and update relevant counters/note; invalid transition corrections receive an actionable explanation |
| AC-12 | ROSC/end | Timers stop, final note appears, and completed session cannot be re-arrested or accidentally restarted |
| AC-13 | AI isolation | Delay, timeout, malformed JSON, unsupported source IDs, and cross-patient late responses do not interrupt event capture or corrupt evidence |
| AC-14 | AI grounding | Ranked hypotheses expose valid findings/dates; sparse data yields uncertainty; no test-manifest answer leakage |
| AC-15 | Final note | Contains only effective documented events with correct times/units; corrections create a revised note; clipboard fallback works |
| AC-16 | Synchronization | Under normal test conditions a saved event reaches viewers within two seconds; an outage produces a stale indicator within five seconds |
| AC-17 | Reload/restart | Timer anchors and saved state survive page reload and application restart |
| AC-18 | Conflicting writes | Duplicate retries do not duplicate events; stale revisions and invalidated recorder leases are rejected |
| AC-19 | UI access | Main workflow works by keyboard, timers remain visible, and there is no reliance on color alone |
| AC-20 | Injection/secrets | Free text cannot execute HTML/scripts; chart text cannot invoke tools; browser receives no Azure API key or password hash |

Add end-to-end browser tests for one adult arrest ending in ROSC, one pediatric weight correction and dose entry, one pulse-present workflow, one audited deletion, and a viewer permission attempt. Use actual reference-derived expected clinical values in tests, independent of the implementation's own configuration, so tests do not merely repeat a wrong constant.

Exercise all ten fixtures during manual scenario review. Record clinical-content review status separately from software test results; passing software tests does not itself constitute clinical validation.

## 16. Delivery and implementation order

Deliver source code, all ten JSON fixtures, schema/fixture validation, versioned protocol rules with source mapping, migrations, tests, `.env.example`, local setup instructions, and Azure deployment instructions. Include a brief protocol coverage/review report and a known-limitations file.

Build in this order:

1. Flask foundation, authentication, JSON patient repository, database schema, and session/event persistence.
2. Desktop recording workspace, explicit state transitions, reliable timers, intervention drawer, and read-only board.
3. Versioned adult/pediatric rules, medication prompts, weight handling, and protocol golden tests.
4. Azure OpenAI and mock provider, evidence-linked summaries, and failure handling.
5. Audited corrections, deterministic copyable note, restart/reconnect tests, and Azure deployment documentation.

At completion, demonstrate the main adult and pediatric journeys with synthetic data and explain any unresolved clinical-rule verification. Do not substitute placeholders for required workflows while claiming the prototype is complete. If a source cannot be verified, identify the specific blocked rule and preserve the functioning documentation workflow without inventing clinical parameters.

## 17. Reference baseline

References checked September 23, 2026. Clinical parameter verification belongs in the implementation's protocol source map; this document intentionally avoids serving as an exhaustive medication or energy table.

- [AHA 2025 algorithms](https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/algorithms)
- [AHA 2025 adult advanced life support](https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-advanced-life-support)
- [AHA 2025 pediatric advanced life support](https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/pediatric-advanced-life-support)
- [Azure App Service: Python deployment](https://learn.microsoft.com/en-us/azure/app-service/quickstart-python)
- [Azure App Service: persistent storage](https://learn.microsoft.com/en-us/azure/app-service/configure-custom-container#use-persistent-shared-storage)
- [Azure OpenAI: Responses API](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses)
