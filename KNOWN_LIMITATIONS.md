# Known limitations

This is an early foundation milestone, not a complete resuscitation application.

- Session creation, explicit start/hold/rhythm/resume/ROSC/end transitions, manual intervention/findings capture, per-session recorder lease and audited takeover, derived timers, polling, recorder workspace, and read-only status board are implemented in this milestone.
- Event and weight correction/deletion flows, recorder audit-history page, final note generation, lease expiry/renewal, and full access-history retention are not implemented yet.
- Protocol rules and medication/energy calculations are intentionally absent until verified against the specified 2025 AHA primary sources and reviewed. See `PROTOCOL_COVERAGE.md`.
- No AI provider or summary UI is implemented yet. The configured `AI_PROVIDER=mock` value is preparatory configuration only; it does not produce a summary.
- The fixture projection resolves record offsets against a caller-provided anchor and applies a calendar-month lookback. It preserves conflicting code-status records and source evidence. The session workflow currently snapshots fixture weight but does not yet offer audited weight correction.
- PostgreSQL is configured via `DATABASE_URL`, but migrations have not yet been generated or exercised against PostgreSQL.
- Login throttling currently uses Flask-Limiter's default in-process storage. Production multi-worker/multi-instance deployment needs a shared rate-limit store before deployment.
- The application has not undergone clinical, security, accessibility, or Azure deployment review. No live use is supported.
