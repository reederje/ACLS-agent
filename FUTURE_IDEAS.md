# Future ideas (parked)

Ideas that are not scheduled. Move an item into active work when it is prioritized.

## Speed and click reduction

- **Reversible-cause buttons (Hs and Ts):** give each AI-suggested cause a one-tap "Treated" / "Ruled out" action that records an entry in the history pane.
- **Keyboard shortcuts:** single keys for the most common actions (for example E for epinephrine, S for shock, H for compressions held, R for resume).
- **Larger touch targets:** a tablet-friendly mode with bigger buttons for the next-step and rhythm controls.

## Documentation and history

- **Undo for compression hold/resume and lifecycle events:** currently only documentation entries and rhythm assessments can be undone, because compression and lifecycle state is stored outside the event log.
- **Undo for ROSC and End session:** reopening an ended session needs an explicit policy.
- **Edit an entry** (not just undo and re-enter), with the audit trail.
- **Weight correction** with an audited revision, used by weight-based dose prefill.

## Clinical content

- **Clinician review of quick-select doses** in `app/static/js/catalog.js` (dose chips, shock energies, presets, end and takeover reasons).
- **Weight-based dose chips** (for example lidocaine) computed from the session weight.
