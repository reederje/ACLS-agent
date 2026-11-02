// Quick-select values for one-tap documentation. Doses are shortcuts for clinician review; "Other" always allows a custom value.
window.QUICK_CATALOG = {
  routes: ["IV", "IO", "IM", "ET"],
  shockEnergies: [120, 150, 200, 360],
  medications: [
    {
      group: "Adult ACLS algorithm medications",
      items: [
        { name: "Epinephrine", units: "mg", doses: [1] },
        { name: "Amiodarone", units: "mg", doses: [300, 150] },
        { name: "Lidocaine", units: "mg", doses: [] },
        { name: "Atropine", units: "mg", doses: [1] },
        { name: "Adenosine", units: "mg", doses: [6, 12] },
        { name: "Procainamide", units: "mg", doses: [] },
        { name: "Sotalol", units: "mg", doses: [] },
      ],
    },
    {
      group: "Reversible-cause documentation (not routine ACLS drugs)",
      items: [
        { name: "Magnesium sulfate", units: "g", doses: [1, 2] },
        { name: "Sodium bicarbonate", units: "mEq", doses: [50] },
        { name: "Calcium gluconate", units: "g", doses: [1, 3] },
        { name: "Calcium chloride", units: "g", doses: [1] },
        { name: "Dextrose 5% (D5)", units: "g", doses: [] },
        { name: "Dextrose 10% (D10)", units: "g", doses: [25] },
        { name: "Dextrose 25% (D25)", units: "g", doses: [] },
        { name: "Dextrose 50% (D50)", units: "g", doses: [25] },
        { name: "Naloxone", units: "mg", doses: [0.4, 2] },
      ],
    },
  ],
  presets: {
    airway: ["ETT placed", "Supraglottic airway placed", "BVM ventilation", "Waveform capnography attached", "Oxygen applied"],
    procedure: ["IV access established", "IO access established", "Central venous access", "Needle decompression", "Pericardiocentesis"],
    assessment: ["POCUS performed", "Fingerstick glucose checked", "12-lead ECG obtained", "Temperature measured"],
  },
  endReasons: ["Resuscitation terminated", "Transferred to higher level of care", "Simulation ended"],
  takeoverReasons: ["Handoff to new recorder", "Device problem", "Browser refreshed"],
};
