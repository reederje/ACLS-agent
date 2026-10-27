# Protocol coverage and review status

**Ruleset:** `2025-AHA-adult-arrest-v1` (adult cardiac arrest only). **Review status:** Adult arrest flow approved by the project clinician reviewer for synthetic simulation implementation. **Runtime status:** Deterministic advisory guidance is enabled only for adult cardiac arrest; this is not validation for live-patient use.

| Population / workflow | Required source | Coverage | Verification | Clinical review |
| --- | --- | --- | --- | --- |
| Adult cardiac arrest — shockable | 2025 AHA Adult Cardiac Arrest Algorithm | Implemented as deterministic advisory guidance | Automated branch/timing tests; no medication dose or route calculations | Flow approved for synthetic simulation by project clinician reviewer (2026-10-08); not live-use validation |
| Adult cardiac arrest — nonshockable | 2025 AHA Adult Cardiac Arrest Algorithm | Implemented as deterministic advisory guidance | Automated branch/timing tests; no medication dose or route calculations | Flow approved for synthetic simulation by project clinician reviewer (2026-10-08); not live-use validation |
| Adult bradycardia with pulse | 2025 AHA adult advanced life support | Not implemented | Pending primary-source transcription | Pending |
| Adult tachyarrhythmia with pulse | 2025 AHA adult advanced life support | Not implemented | Pending primary-source transcription | Pending |
| Pediatric cardiac arrest — shockable | 2025 AHA pediatric algorithm collection and pediatric advanced life support | Not implemented | Pending primary-source transcription | Pending |
| Pediatric cardiac arrest — nonshockable | 2025 AHA pediatric algorithm collection and pediatric advanced life support | Not implemented | Pending primary-source transcription | Pending |
| Pediatric bradycardia with pulse | 2025 AHA pediatric advanced life support | Not implemented | Pending primary-source transcription | Pending |
| Pediatric tachyarrhythmia with pulse | 2025 AHA pediatric advanced life support | Not implemented | Pending primary-source transcription | Pending |

The adult-arrest rules provide rhythm/pulse prompts, a two-minute cycle cue, single-shock advice for a documented pulseless shockable rhythm, epinephrine interval reminders derived from recorded administrations, and conditional amiodarone-or-lidocaine guidance capped at two recorded doses. They do not calculate medication doses/routes or perform actions. The CPR and shock detail dialogs are informational; clinicians remain responsible for decisions and documentation.

Primary references:

- https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/algorithms
- https://cpr.heart.org/-/media/CPR-Files/CPR-Guidelines-Files/2025-Algorithms/Algorithm-ACLS-CA-250527.pdf?sc_lang=en
- https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-advanced-life-support
- https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/pediatric-advanced-life-support

This report intentionally records missing work rather than inventing values. Passing application tests is not clinical validation, and this synthetic prototype is not for live-patient use.
