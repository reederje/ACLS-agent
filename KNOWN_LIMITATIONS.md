# Known limitations

This is an early foundation milestone, not a complete resuscitation application.

- Session creation, explicit start/hold/rhythm/resume/ROSC/end transitions, manual intervention/findings capture, per-session recorder lease and audited takeover, derived timers, polling, recorder workspace, and read-only status board are implemented in this milestone.
- Event and weight correction/deletion flows, recorder audit-history page, final note generation, lease expiry/renewal, and full access-history retention are not implemented yet.
- Deterministic advisory rules are implemented only for the clinician-approved adult cardiac-arrest flow in `app/protocol_rules.py`. The app does not calculate medication doses/routes; all other adult and pediatric ACLS/PALS pathways remain disabled. This is synthetic-simulation functionality, not clinical validation or authorization for live use. See `PROTOCOL_COVERAGE.md`.
- An advisory AI summary and top-3 potential causes of arrest are generated asynchronously at session start (direct OpenAI API when `AI_PROVIDER=openai` with `OPENAI_API_KEY`; otherwise a labeled mock placeholder). Output is stored in `AIResult`, validated against a JSON schema, never changes protocol guidance, and is synthetic-data-only. Generation uses an in-process thread, so it is lost if the process restarts mid-generation (shown as unavailable). Sex is not in the fixtures and is not sent.
- The fixture projection resolves record offsets against a caller-provided anchor and applies a calendar-month lookback. It preserves conflicting code-status records and source evidence. The session workflow currently snapshots fixture weight but does not yet offer audited weight correction.
- PostgreSQL is configured via `DATABASE_URL`, but migrations have not yet been generated or exercised against PostgreSQL.
- Login throttling currently uses Flask-Limiter's default in-process storage. Production multi-worker/multi-instance deployment needs a shared rate-limit store before deployment.
- The application has not undergone clinical, security, accessibility, or Azure deployment review. No live use is supported.
