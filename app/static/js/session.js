(() => {
  const sessionId = document.querySelector("meta[name='session-id']").content;
  const canRecord = document.querySelector("#workspace").dataset.canRecord === "true";
  const leaseKey = `recorder-lease:${sessionId}`;
  let leaseToken = canRecord ? sessionStorage.getItem(leaseKey) : null;
  let state = null;
  let serverEpochMs = 0;
  let syncMonotonicMs = 0;
  let stale = false;
  let busy = false;
  let lastRenderedRevision = -1;
  let lastGuidanceSignature = null;
  let lastNextStepsSignature = null;
  let lastSuccessfulSync = 0;
  let lastResuscitationCheckpoint = 0;
  let finalResuscitationRequested = false;
  let resuscitationRequestInFlight = false;
  let resuscitationStatusInFlight = false;
  let resuscitationRetryAt = 0;
  const status = document.querySelector("#save-status");
  const csrfToken = document.querySelector("meta[name='csrf-token']").content;
  const api = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const label = (value) => String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const rhythmLabel = (rhythm) => ({ vf: "VF", vt: "VT", pea: "PEA", rosc: "ROSC" })[rhythm] || label(rhythm);
  const nowEpochMs = () => serverEpochMs + (performance.now() - syncMonotonicMs);
  const pad = (number) => String(number).padStart(2, "0");
  const formatClock = (seconds) => {
    const safe = Math.max(0, Math.floor(seconds));
    return `${pad(Math.floor(safe / 3600))}:${pad(Math.floor((safe % 3600) / 60))}:${pad(safe % 60)}`;
  };
  const formatDuration = (seconds) => {
    const safe = Math.max(0, Math.floor(seconds));
    return `${Math.floor(safe / 60)}:${pad(safe % 60)}`;
  };
  const formatTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }) : "—";
  const elapsedFrom = (iso) => iso ? Math.max(0, (nowEpochMs() - Date.parse(iso)) / 1000) : 0;
  const input = (name, title, type = "text", required = false, placeholder = "") => {
    const wrap = document.createElement("label");
    wrap.textContent = title;
    const field = document.createElement("input");
    field.name = name;
    field.type = type;
    field.required = required;
    field.placeholder = placeholder;
    if (type === "number") { field.step = "any"; field.min = "0"; }
    if (type === "datetime-local") field.step = "1";
    wrap.append(field);
    return wrap;
  };

  const catalog = window.QUICK_CATALOG;
  let doc = null;
  const TIME_OPTIONS = [
    { label: "Now", value: 0 },
    { label: "1 min ago", value: 1 },
    { label: "2 min ago", value: 2 },
    { label: "5 min ago", value: 5 },
    { label: "Custom…", value: "custom" },
  ];
  const CHIP_CATEGORIES = ["medication_admin", "electrical_therapy", "airway", "procedure", "assessment"];
  const UNDOABLE_TYPES = new Set(["rhythm_assessment", "medication_admin", "infusion", "electrical_therapy", "airway", "procedure", "assessment", "other"]);
  const RHYTHM_GROUPS = [
    { title: "Shockable", items: [{ label: "VF", rhythm: "vf", pulse: "absent" }, { label: "VT — pulseless", rhythm: "vt", pulse: "absent" }] },
    { title: "Non-shockable", items: [{ label: "PEA", rhythm: "pea", pulse: "absent" }, { label: "Asystole", rhythm: "asystole", pulse: "absent" }, { label: "Unknown", rhythm: "unknown", pulse: "absent" }] },
    { title: "Pulse present", pulsePresent: true, items: [{ label: "VT — with pulse", rhythm: "vt", pulse: "present" }, { label: "ROSC", rhythm: "rosc", pulse: "present" }] },
  ];

  function chipGroup(title, options, { scope, selected = null, onPick }) {
    const wrap = document.createElement("div");
    wrap.className = "chip-field";
    if (title) {
      const heading = document.createElement("span");
      heading.className = "chip-label";
      heading.textContent = title;
      wrap.append(heading);
    }
    const row = document.createElement("div");
    row.className = "chip-row";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", title || "Options");
    for (const option of options) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.scope = scope;
      chip.textContent = option.label;
      chip.setAttribute("aria-pressed", String(option.value === selected));
      chip.addEventListener("click", () => {
        document.querySelectorAll(`.chip[data-scope="${scope}"]`).forEach((other) => other.setAttribute("aria-pressed", "false"));
        chip.setAttribute("aria-pressed", "true");
        onPick(option.value);
      });
      row.append(chip);
    }
    wrap.append(row);
    return wrap;
  }

  function timeField() {
    const wrap = document.createElement("div");
    const custom = input("custom_time", "Custom time", "datetime-local");
    custom.hidden = true;
    const customInput = custom.querySelector("input");
    customInput.addEventListener("input", () => { doc.customTime = customInput.value; });
    wrap.append(chipGroup("Time", TIME_OPTIONS, {
      scope: "doc-time",
      selected: 0,
      onPick: (value) => {
        doc.time = value;
        custom.hidden = value !== "custom";
        if (value === "custom") {
          customInput.value = localDateTimeValue(nowEpochMs());
          doc.customTime = customInput.value;
          customInput.focus();
        }
      },
    }), custom);
    return wrap;
  }

  function occurredAt() {
    if (doc.time === "custom") return doc.customTime ? new Date(doc.customTime).toISOString() : null;
    return new Date(nowEpochMs() - doc.time * 60000).toISOString();
  }

  function docComplete() {
    const fields = doc.fields;
    if (doc.category === "medication_admin") return Boolean(fields.title && fields.units && fields.dose > 0 && fields.route);
    if (doc.category === "electrical_therapy") return fields.therapy_type === "pacing" ? Boolean(fields.settings) : Boolean(fields.therapy_type && fields.energy_joules > 0);
    return Boolean(fields.title);
  }

  function autoRecord() {
    if (doc?.mode === "chips" && doc.time !== "custom" && docComplete()) document.querySelector("#event-form").requestSubmit();
  }

  function renderChipForm(category) {
    const holder = document.querySelector("#event-fields");
    holder.replaceChildren();
    holder.className = "event-fields chip-form";
    doc = { mode: "chips", category, time: 0, customTime: "", fields: {} };
    if (category === "medication_admin") renderMedicationChips(holder);
    else if (category === "electrical_therapy") renderElectricalChips(holder);
    else renderPresetChips(holder, category);
    holder.append(timeField());
  }

  function renderMedicationChips(holder) {
    const detail = document.createElement("div");
    detail.className = "chip-detail";
    const all = catalog.medications.flatMap((group) => group.items);
    const clearScope = (scope) => document.querySelectorAll(`.chip[data-scope="${scope}"]`).forEach((chip) => chip.setAttribute("aria-pressed", "false"));
    let medication = null;
    const draw = () => {
      detail.replaceChildren();
      if (!medication) return;
      if (medication.other) {
        const name = input("custom_medication", "Medication name", "text", true);
        name.querySelector("input").addEventListener("input", (event) => { doc.fields.title = event.target.value.trim(); });
        const units = input("units", "Dose units", "text", true, "e.g., mg");
        units.querySelector("input").addEventListener("input", (event) => { doc.fields.units = event.target.value.trim(); });
        detail.append(name, units);
      }
      if (medication.doses.length) {
        detail.append(chipGroup("Dose", medication.doses.map((dose) => ({ label: `${dose} ${medication.units}`, value: dose })), {
          scope: "doc-dose",
          selected: doc.fields.dose ?? null,
          onPick: (dose) => { doc.fields.dose = dose; doc.fields.units = medication.units; autoRecord(); },
        }));
      }
      const otherDose = input("other_dose", medication.doses.length ? "Other dose" : "Dose", "number");
      otherDose.querySelector("input").addEventListener("input", (event) => {
        clearScope("doc-dose");
        doc.fields.dose = event.target.value === "" ? undefined : Number(event.target.value);
        if (!medication.other) doc.fields.units = medication.units;
      });
      detail.append(otherDose);
      detail.append(chipGroup("Route", catalog.routes.map((route) => ({ label: route, value: route })), {
        scope: "doc-route",
        selected: doc.fields.route ?? null,
        onPick: (route) => { doc.fields.route = route; autoRecord(); },
      }));
    };
    const pick = (choice) => {
      medication = choice;
      doc.fields = { route: doc.fields.route, title: choice.other ? "" : choice.name, units: choice.units };
      draw();
    };
    for (const group of catalog.medications) {
      holder.append(chipGroup(group.group, group.items.map((item) => ({ label: item.name, value: item.name })), {
        scope: "doc-med",
        onPick: (name) => pick(all.find((item) => item.name === name)),
      }));
    }
    holder.append(chipGroup(null, [{ label: "Other medication…", value: "__other__" }], {
      scope: "doc-med",
      onPick: () => pick({ other: true, doses: [], units: "" }),
    }), detail);
  }

  function renderElectricalChips(holder) {
    const detail = document.createElement("div");
    detail.className = "chip-detail";
    const draw = () => {
      detail.replaceChildren();
      const type = doc.fields.therapy_type;
      if (type === "pacing") {
        const settings = input("settings", "Pacing settings", "text", true);
        settings.querySelector("input").addEventListener("input", (event) => { doc.fields.settings = event.target.value.trim(); });
        detail.append(settings);
      } else if (type) {
        detail.append(chipGroup("Delivered energy", catalog.shockEnergies.map((joules) => ({ label: `${joules} J`, value: joules })), {
          scope: "doc-energy",
          onPick: (joules) => { doc.fields.energy_joules = joules; autoRecord(); },
        }));
        const other = input("other_energy", "Other energy (J)", "number");
        other.querySelector("input").addEventListener("input", (event) => {
          document.querySelectorAll('.chip[data-scope="doc-energy"]').forEach((chip) => chip.setAttribute("aria-pressed", "false"));
          doc.fields.energy_joules = event.target.value === "" ? undefined : Number(event.target.value);
        });
        detail.append(other);
      }
    };
    holder.append(chipGroup("Therapy", [
      { label: "Defibrillation", value: "defibrillation" },
      { label: "Synchronized cardioversion", value: "synchronized_cardioversion" },
      { label: "Pacing", value: "pacing" },
    ], {
      scope: "doc-therapy",
      onPick: (type) => { doc.fields = { therapy_type: type, title: label(type) }; draw(); },
    }), detail);
  }

  function renderPresetChips(holder, category) {
    const detail = document.createElement("div");
    detail.className = "chip-detail";
    const options = [...catalog.presets[category].map((text) => ({ label: text, value: text })), { label: "Other…", value: "__other__" }];
    holder.append(chipGroup("Choose", options, {
      scope: "doc-preset",
      onPick: (value) => {
        detail.replaceChildren();
        if (value === "__other__") {
          doc.fields = {};
          const text = input("title", "What was documented?", "text", true);
          text.querySelector("input").addEventListener("input", (event) => { doc.fields.title = event.target.value.trim(); });
          detail.append(text);
          text.querySelector("input").focus();
        } else {
          doc.fields = { title: value };
          autoRecord();
        }
      },
    }), detail);
  }

  function rhythmButtons({ pulsePresent }) {
    const wrap = document.createElement("div");
    wrap.className = "rhythm-groups";
    for (const group of RHYTHM_GROUPS) {
      if (group.pulsePresent && !pulsePresent) continue;
      const section = document.createElement("div");
      section.className = "rhythm-group";
      const heading = document.createElement("span");
      heading.className = "chip-label";
      heading.textContent = group.title;
      const row = document.createElement("div");
      row.className = "chip-row";
      for (const item of group.items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button button-secondary rhythm-button";
        button.dataset.rhythm = item.rhythm;
        button.dataset.pulse = item.pulse;
        button.textContent = item.label;
        button.disabled = !canWrite();
        row.append(button);
      }
      section.append(heading, row);
      wrap.append(section);
    }
    return wrap;
  }

  function stepButton(text, attributes = {}, extraClass = "button-primary") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${extraClass} next-step-button`;
    Object.assign(button.dataset, attributes);
    button.textContent = text;
    button.disabled = !canWrite();
    return button;
  }

  const lastShockEnergy = () => [...(state?.events || [])].reverse()
    .find((item) => item.type === "electrical_therapy" && item.payload?.therapy_type === "defibrillation" && item.payload?.energy_joules)?.payload.energy_joules ?? null;
  const lastRoute = () => [...(state?.events || [])].reverse()
    .find((item) => item.type === "medication_admin" && item.payload?.route)?.payload.route ?? null;

  function buildStepActions(step) {
    const actions = document.createElement("div");
    actions.className = "next-step-actions";
    const edit = (text) => stepButton(text, { nextStepAction: step.action, stepId: step.id }, "button-quiet");
    if (step.action === "administer_epinephrine") {
      const dose = step.dose ?? 1;
      for (const route of step.routes || ["IV", "IO"]) actions.append(stepButton(`Epinephrine ${dose} mg ${route}`, { quick: "epinephrine", route, dose }));
      actions.append(edit("Edit details"));
    } else if (step.action === "record_shock") {
      const last = lastShockEnergy();
      const energies = [...new Set([...(last ? [last] : []), ...catalog.shockEnergies])];
      for (const joules of energies) actions.append(stepButton(joules === last ? `Same as last · ${joules} J` : `Shock ${joules} J`, { quick: "shock", joules }));
      actions.append(edit("Other energy"));
    } else if (step.action === "administer_antiarrhythmic") {
      const route = lastRoute() || "IV";
      for (const [agent, option] of Object.entries(step.options || {})) {
        if (!option.available || option.dose == null) continue;
        actions.append(stepButton(`${label(agent)} ${option.dose} ${option.units} ${route}`, { quick: "antiarrhythmic", agent, dose: option.dose, units: option.units, route }));
      }
      actions.append(edit("Edit details"));
    } else if (step.action === "record_initial_rhythm") {
      actions.append(rhythmButtons({ pulsePresent: false }));
    } else {
      const text = ({
        start: state?.workflow === "cardiac_arrest" ? "Start code" : "Start session",
        pulse_check: state?.compression_status === "held" ? "Document rhythm and pulse" : "Start pulse check",
        resume: "Resume compressions",
        rosc: "Record ROSC",
      })[step.action] || "Start action";
      actions.append(stepButton(text, { nextStepAction: step.action, stepId: step.id }));
    }
    return actions;
  }

  async function quickRecord(data) {
    const occurred = new Date(nowEpochMs()).toISOString();
    let eventType = "medication_admin";
    let payload;
    if (data.quick === "epinephrine") payload = { title: "Epinephrine", dose: Number(data.dose), units: "mg", route: data.route };
    else if (data.quick === "antiarrhythmic") payload = { title: label(data.agent), dose: Number(data.dose), units: data.units || "mg", route: data.route };
    else {
      eventType = "electrical_therapy";
      payload = { title: "Defibrillation", therapy_type: "defibrillation", energy_joules: Number(data.joules) };
    }
    await write(`${api}/events`, { event_type: eventType, payload: { ...payload, occurred_at: occurred }, idempotency_key: crypto.randomUUID() });
  }

  async function recordRhythm(rhythm, pulse) {
    const dialog = document.querySelector("#pulse-check-dialog");
    const error = document.querySelector("#rhythm-save-error");
    error.hidden = true;
    const saved = await write(`${api}/actions`, { action: "rhythm_assessment", details: { rhythm, pulse }, idempotency_key: crypto.randomUUID() });
    if (saved) dialog.close();
    else if (dialog.open) { error.textContent = status.textContent; error.hidden = false; }
  }

  function openRhythmDialog() {
    document.querySelector("#rhythm-buttons").replaceChildren(rhythmButtons({ pulsePresent: true }));
    document.querySelector("#rhythm-save-error").hidden = true;
    document.querySelector("#pulse-check-dialog").showModal();
  }

  let roscArmTimer = null;
  function disarmRosc(button) {
    window.clearTimeout(roscArmTimer);
    delete button.dataset.armed;
    button.textContent = button.dataset.label;
    button.classList.remove("is-armed");
  }
  function armRosc(button) {
    if (button.dataset.armed === "true") {
      disarmRosc(button);
      write(`${api}/actions`, { action: "rosc", details: {}, idempotency_key: crypto.randomUUID() });
      return;
    }
    button.dataset.armed = "true";
    button.textContent = "Tap again to confirm ROSC";
    button.classList.add("is-armed");
    roscArmTimer = window.setTimeout(() => disarmRosc(button), 5000);
  }

  // The option form temporarily replaces the category buttons.
  function setDocumentationOpen(open) {
    document.querySelector(".intervention-panel .tile-grid").hidden = open;
    document.querySelector("#event-form").hidden = !open;
  }

  function makeFields(category) {
    const holder = document.querySelector("#event-fields");
    holder.replaceChildren();
    holder.className = "event-fields";
    if (category === "infusion") {
      const infusionLabel = document.createElement("label");
      infusionLabel.textContent = "Infusion medication";
      const infusionSelect = document.createElement("select");
      infusionSelect.name = "infusion_choice";
      infusionSelect.required = true;
      infusionSelect.innerHTML = '<option value="" disabled selected>Select medication…</option><option>Epinephrine infusion</option><option>Dopamine infusion</option><option value="__other__">Other infusion…</option>';
      const customInfusion = input("custom_infusion_medication", "Enter other infusion medication", "text", false);
      customInfusion.hidden = true;
      infusionLabel.append(infusionSelect);
      holder.append(infusionLabel, customInfusion);
      const infusionNotice = document.createElement("p");
      infusionNotice.className = "muted medication-catalog-note";
      infusionNotice.textContent = "Infusion documentation only—not a treatment recommendation. Enter the actual rate and concentration; none is preselected.";
      holder.append(infusionNotice);
      infusionSelect.addEventListener("change", () => {
        const isOther = infusionSelect.value === "__other__";
        customInfusion.hidden = !isOther;
        customInfusion.querySelector("input").required = isOther;
        if (isOther) customInfusion.querySelector("input").focus();
      });
    } else {
      const title = input("title", "What was documented?", "text", true);
      holder.append(title);
    }
    if (category === "infusion") {
      const activity = document.createElement("label");
      activity.textContent = "Infusion action";
      const select = document.createElement("select");
      select.name = "activity";
      select.required = true;
      select.innerHTML = '<option value="" disabled selected>Select…</option><option value="start">Start</option><option value="rate_change">Rate change</option><option value="stop">Stop</option>';
      activity.append(select);
      holder.append(activity, input("rate", "Rate (when starting/changing)", "number"), input("rate_units", "Rate units", "text", false, "e.g., mcg/min or mL/hr"), input("concentration", "Concentration or ‘not recorded’", "text", true), input("note", "Optional note"));
    } else if (category === "electrical_therapy") {
      const mode = document.createElement("label");
      mode.textContent = "Therapy type";
      const select = document.createElement("select");
      select.name = "therapy_type";
      select.required = true;
      select.innerHTML = '<option value="" disabled selected>Select…</option><option value="defibrillation">Defibrillation</option><option value="synchronized_cardioversion">Synchronized cardioversion</option><option value="pacing">Pacing</option>';
      mode.append(select);
      holder.append(mode, input("energy_joules", "Delivered energy (J), when applicable", "number"), input("settings", "Pacing settings / other details"), input("note", "Optional note"));
    } else if (category === "airway") {
      holder.append(input("device", "Device / ventilation method"), input("outcome", "Attempt outcome / confirmation"), input("note", "Optional note"));
    } else if (category === "procedure") {
      holder.append(input("site", "Site / procedure details"), input("outcome", "Outcome"), input("note", "Optional note"));
    } else if (category === "assessment") {
      holder.append(input("finding", "Finding / value with units"), input("note", "Context / optional note"));
    } else if (category !== "medication_admin") {
      holder.append(input("note", "Free-text details", "text", true));
    }
    holder.append(timeField());
  }

  function renderEvents(events) {
    const list = document.querySelector("#event-list");
    const previousScroll = list.scrollTop;
    const wasAtTop = previousScroll < 12;
    list.replaceChildren();
    for (const event of [...events].reverse()) {
      const item = document.createElement("li");
      item.className = "event-item";
      const heading = document.createElement("div");
      heading.className = "event-heading";
      const title = document.createElement("strong");
      title.textContent = label(event.type);
      const timestamp = document.createElement("time");
      timestamp.dateTime = event.occurred_at;
      timestamp.textContent = formatTime(event.occurred_at);
      heading.append(title, timestamp);
      if (canWrite() && state?.lifecycle === "active" && UNDOABLE_TYPES.has(event.type)) {
        const undo = document.createElement("button");
        undo.type = "button";
        undo.className = "button button-quiet undo-button";
        undo.textContent = "Undo";
        undo.dataset.undoEventId = event.id;
        heading.append(undo);
      }
      const description = document.createElement("p");
      const payload = event.payload || {};
      description.textContent = Object.entries(payload).map(([key, value]) => `${label(key)}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ");
      const recorded = document.createElement("small");
      recorded.textContent = `Recorded ${formatTime(event.recorded_at)} · #${event.sequence}`;
      item.append(heading, description, recorded);
      list.append(item);
    }
    if (!events.length) {
      const empty = document.createElement("li");
      empty.className = "muted empty-log";
      empty.textContent = "No events documented yet.";
      list.append(empty);
    }
    list.scrollTop = wasAtTop ? 0 : previousScroll;
    document.querySelector("#event-count").textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
  }

  function renderRecommendations(guidance) {
    const stableGuidance = { ...(guidance || {}) };
    delete stableGuidance.as_of;
    const signature = JSON.stringify(stableGuidance);
    if (signature === lastGuidanceSignature) return;
    lastGuidanceSignature = signature;
    const summary = document.querySelector("#recommendation-summary");
    const list = document.querySelector("#recommendation-list");
    const badge = document.querySelector("#ruleset-badge");
    const isApplicable = guidance?.status !== "not_applicable";
    summary.textContent = guidance?.summary || "Guidance unavailable.";
    badge.textContent = guidance?.ruleset_version || "Ruleset unavailable";
    document.querySelector(".guidance-help-links").hidden = !isApplicable;
    document.querySelector(".recommendation-source").hidden = !isApplicable;
    list.replaceChildren();
    for (const recommendation of guidance?.recommendations || []) {
      const card = document.createElement("article");
      card.className = "recommendation-item";
      const heading = document.createElement("div");
      heading.className = "recommendation-heading";
      const title = document.createElement("strong");
      title.textContent = recommendation.title || "Guidance";
      const kind = document.createElement("span");
      kind.className = "recommendation-kind";
      kind.textContent = label(recommendation.kind);
      heading.append(title, kind);
      const detail = document.createElement("p");
      detail.textContent = recommendation.text || "";
      card.append(heading, detail);
      if (recommendation.help?.href === "#high-quality-cpr-dialog" || recommendation.help?.href === "#shock-recommendations-dialog") {
        const help = document.createElement("button");
        help.type = "button";
        help.className = "guidance-inline-link";
        help.textContent = recommendation.help.title;
        help.dataset.openGuidance = recommendation.help.href.slice(1);
        card.append(help);
      }
      list.append(card);
    }
  }

  function renderNextSteps(guidance) {
    const steps = guidance?.next_steps || [];
    const signature = JSON.stringify({
      steps: steps.map(({ due_at: _dueAt, overdue_at: _overdueAt, ...step }) => step),
      lastShock: lastShockEnergy(),
      lastRoute: lastRoute(),
      writable: canWrite(),
      visible: steps.filter((step) => !step.due_at || (Date.parse(step.due_at) - nowEpochMs()) / 1000 <= 60).map((step) => step.id),
    });
    const container = document.querySelector("#next-step-list");
    const now = nowEpochMs();
    const visibleSteps = steps.filter((step) => {
      if (!step.due_at) return true;
      return (Date.parse(step.due_at) - now) / 1000 <= 60;
    });

    if (signature !== lastNextStepsSignature) {
      lastNextStepsSignature = signature;
      container.replaceChildren();
      for (const step of visibleSteps) {
        const card = document.createElement("article");
        card.className = "next-step-card";
        card.dataset.stepId = step.id;
        card.dataset.dueAt = step.due_at || "";
        card.dataset.overdueAt = step.overdue_at || "";
        card.dataset.noTimer = String(step.no_timer === true);
        const content = document.createElement("div");
        content.className = "next-step-content";
        const title = document.createElement("h3");
        title.textContent = step.title;
        const detail = document.createElement("p");
        detail.textContent = step.text;
        const countdown = document.createElement("p");
        countdown.className = "next-step-countdown";
        countdown.setAttribute("role", "timer");
        countdown.setAttribute("aria-live", "off");
        countdown.dataset.countdown = "";
        content.append(title, detail, countdown);
        card.append(content, buildStepActions(step));
        container.append(card);
      }
      if (!visibleSteps.length) {
        const empty = document.createElement("p");
        empty.className = "next-steps-empty muted";
        empty.textContent = guidance?.status === "inactive" ? "Start the simulation when ready." : "No action is due within the next minute. Continue documented care and use manual documentation as needed.";
        container.append(empty);
      }
    } else {
      for (const step of visibleSteps) {
        const card = container.querySelector(`[data-step-id="${CSS.escape(step.id)}"]`);
        if (card) {
          card.dataset.dueAt = step.due_at || "";
          card.dataset.overdueAt = step.overdue_at || "";
        }
      }
    }
    updateStepCountdowns();
  }

  function updateStepCountdowns() {
    const now = nowEpochMs();
    const cards = [...document.querySelectorAll(".next-step-card")];
    cards.forEach((card) => {
      const dueAt = card.dataset.dueAt ? Date.parse(card.dataset.dueAt) : null;
      const overdueAt = card.dataset.overdueAt ? Date.parse(card.dataset.overdueAt) : null;
      const countdown = card.querySelector("[data-countdown]");
      const buttons = [...card.querySelectorAll(".next-step-button")];
      const primaries = buttons.filter((item) => item.classList.contains("button-primary"));
      card.classList.remove("is-due-soon", "is-due", "is-overdue");
      primaries.forEach((item) => item.classList.remove("button-danger"));
      if (!dueAt) {
        countdown.textContent = card.dataset.noTimer === "true" ? "No timer" : "Ready when you are";
        return;
      }
      const untilDue = Math.ceil((dueAt - now) / 1000);
      if (untilDue > 0) {
        countdown.textContent = `Due in: ${untilDue} seconds`;
        card.classList.add("is-due-soon");
      } else if (overdueAt && now >= overdueAt) {
        const overdueSeconds = Math.floor((now - overdueAt) / 1000);
        countdown.textContent = `Overdue by: ${overdueSeconds} seconds`;
        card.classList.add("is-overdue");
        primaries.forEach((item) => item.classList.add("button-danger"));
      } else if (overdueAt) {
        const untilOverdue = Math.max(0, Math.ceil((overdueAt - now) / 1000));
        countdown.textContent = `Due now · overdue in: ${untilOverdue} seconds`;
        card.classList.add("is-due");
      } else {
        countdown.textContent = "Due now";
        card.classList.add("is-due");
      }
      buttons.forEach((item) => { item.disabled = !canWrite(); });
    });
    cards.sort((left, right) => compareStepUrgency(left, right, now));
    const container = document.querySelector("#next-step-list");
    // Re-inserting a node mid-click cancels the click, so only move cards when the order changed.
    const reordered = cards.some((card, index) => container.children[index] !== card);
    if (reordered) cards.forEach((card) => container.append(card));
  }

  function compareStepUrgency(left, right, now) {
    const urgency = (card) => {
      const dueAt = card.dataset.dueAt ? Date.parse(card.dataset.dueAt) : null;
      const overdueAt = card.dataset.overdueAt ? Date.parse(card.dataset.overdueAt) : null;
      if (overdueAt !== null && now >= overdueAt) return [0, overdueAt];
      if (dueAt !== null && dueAt <= now) return [1, dueAt];
      if (dueAt !== null) return [2, dueAt];
      return [3, Number.POSITIVE_INFINITY];
    };
    const [leftRank, leftTime] = urgency(left);
    const [rightRank, rightTime] = urgency(right);
    return leftRank - rightRank || leftTime - rightTime || left.dataset.stepId.localeCompare(right.dataset.stepId);
  }

  const localDateTimeValue = (epochMs) => {
    const date = new Date(epochMs);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 19);
  };

  function openEpinephrineDialog() {
    const form = document.querySelector("#epinephrine-form");
    form.reset();
    const step = state?.recommendations?.next_steps?.find((item) => item.id === "adult-arrest-epinephrine");
    form.elements.dose.value = String(step?.dose ?? 1);
    form.elements.title.value = "Epinephrine";
    form.elements.occurred_at.value = localDateTimeValue(nowEpochMs());
    const previous = [...(state?.events || [])].reverse().find((event) =>
      event.type === "medication_admin" && String(event.payload?.title || "").toLowerCase().includes("epinephrine") && event.payload?.route
    );
    if (previous) {
      const route = String(previous.payload.route);
      if (![...form.elements.route.options].some((option) => option.value === route)) {
        form.elements.route.add(new Option(route, route));
      }
      form.elements.route.value = route;
    }
    const routeSelect = form.elements.route;
    const allowedRoutes = step?.routes || ["IV", "IO"];
    for (const route of allowedRoutes) {
      if (![...routeSelect.options].some((option) => option.value === route)) routeSelect.add(new Option(route, route));
    }
    form.querySelector(".form-error").hidden = true;
    document.querySelector("#epinephrine-dialog").showModal();
  }

  function openShockDialog() {
    const form = document.querySelector("#shock-record-form");
    form.reset();
    form.elements.occurred_at.value = localDateTimeValue(nowEpochMs());
    form.querySelector(".form-error").hidden = true;
    document.querySelector("#shock-record-dialog").showModal();
  }

  function openAntiarrhythmicDialog() {
    const step = state?.recommendations?.next_steps?.find((item) => item.id === "adult-arrest-antiarrhythmic");
    if (!step) return;
    const form = document.querySelector("#antiarrhythmic-form");
    const agentSelect = form.elements.agent;
    agentSelect.replaceChildren();
    for (const [agent, option] of Object.entries(step.options || {})) {
      const choice = new Option(label(agent), agent, false, false);
      choice.disabled = !option.available;
      choice.dataset.dose = option.dose == null ? "" : String(option.dose);
      choice.dataset.units = option.units || "mg";
      choice.dataset.range = option.range || "";
      agentSelect.add(choice);
    }
    const firstAvailable = [...agentSelect.options].find((option) => !option.disabled);
    if (!firstAvailable) return;
    agentSelect.value = firstAvailable.value;
    form.dataset.doseNumber = String(step.dose_number);
    form.elements.occurred_at.value = localDateTimeValue(nowEpochMs());
    form.elements.note.value = "";
    form.querySelector(".form-error").hidden = true;
    const updateDose = () => {
      const selected = agentSelect.selectedOptions[0];
      form.elements.dose.value = selected.dataset.dose;
      document.querySelector("#antiarrhythmic-dose-guidance").textContent = `${selected.dataset.range}. IV/IO. The dose field is editable.`;
      const previous = [...(state?.events || [])].reverse().find((event) =>
        event.type === "medication_admin" && String(event.payload?.title || "").toLowerCase().includes(selected.value) && event.payload?.route
      );
      form.elements.route.value = previous?.payload?.route || "IV";
    };
    agentSelect.onchange = updateDose;
    updateDose();
    document.querySelector("#antiarrhythmic-dialog").showModal();
  }

  async function startPulseCheck() {
    if (state?.compression_status === "running") {
      const saved = await write(`${api}/actions`, { action: "hold", details: {}, idempotency_key: crypto.randomUUID() });
      if (!saved) return;
    }
    if (state?.compression_status === "held") openRhythmDialog();
  }

  function updateState(snapshot, synchronized = false) {
    // A poll that was in flight during a save can arrive with an older revision and visually undo it.
    if (synchronized && state && snapshot.revision < state.revision) return;
    state = snapshot;
    if (synchronized) {
      serverEpochMs = Date.parse(snapshot.server_time);
      syncMonotonicMs = performance.now();
      lastSuccessfulSync = performance.now();
      stale = false;
      document.querySelector("#save-status").textContent = canRecord && !leaseToken ? "Read only here · recorder lease not present" : "Connected · synchronized";
      document.querySelector("#save-status").classList.remove("stale-text");
    }
    document.querySelector("#workflow-label").textContent = label(state.workflow);
    document.querySelector("#lifecycle").textContent = label(state.lifecycle);
    document.querySelector("#session-state-label").textContent = state.lifecycle === "ready" ? "Ready to start" : state.lifecycle === "ended" ? `Ended · ${label(state.outcome)}` : "Session active";
    const isArrest = state.workflow === "cardiac_arrest";
    document.querySelector("#start-caption").textContent = isArrest ? "Starting also records the explicit start of compressions." : "Starts elapsed session time only; no CPR is implied.";
    const ready = state.lifecycle === "ready";
    const active = state.lifecycle === "active";
    document.querySelector("#ready-actions").hidden = !ready;
    document.querySelector("[data-action='start']").textContent = isArrest ? "Start code" : "Start session";
    document.querySelector("#active-actions").hidden = !active;
    document.querySelector("[data-action='hold']").hidden = !isArrest || state.compression_status !== "running";
    document.querySelector("[data-action='resume']").hidden = !isArrest || state.compression_status !== "held";
    document.querySelector("[data-action='start_arrest']").hidden = !active || isArrest;
    document.querySelector("[data-action='cpr_start']").hidden = !active || isArrest || state.compression_status !== "not_started";
    const compressionElapsed = state.compression_anchor_at ? elapsedFrom(state.compression_anchor_at) : 0;
    const checkDue = isArrest && state.compression_status === "running" && compressionElapsed >= 120;
    const held = state.compression_status === "held" && state.hold_anchor_at;
    document.querySelector("#compression-state").textContent = held
      ? `Compressions held · pause ${formatDuration(elapsedFrom(state.hold_anchor_at))}`
      : checkDue
        ? `Pulse check due · overdue ${formatDuration(compressionElapsed - 120)}`
        : label(state.compression_status);
    document.querySelector("#compression-state").classList.toggle("pulse-overdue", Boolean(checkDue));
    document.querySelector("#cycle-caption").textContent = isArrest ? "Compression cycle" : state.compression_status === "running" ? "CPR elapsed" : "Compression-cycle timer";
    const assessment = state.rhythm_assessment;
    document.querySelector("#rhythm-state").textContent = assessment ? `${rhythmLabel(assessment.rhythm)} · pulse ${label(assessment.pulse)}` : isArrest ? "Unknown" : "Not assessed";
    document.querySelector("#rhythm-details").textContent = assessment ? "Assessment recorded" : isArrest ? "Initial rhythm unknown · first check at 2 minutes" : "No assessment recorded";
    document.querySelectorAll(".category-tile").forEach((button) => { button.disabled = !active || !canWrite(); });
    if (!active) { setDocumentationOpen(false); doc = null; }
    const writer = canWrite();
    document.querySelectorAll("#ready-actions button, #active-actions button").forEach((button) => { button.disabled = !writer || busy; });
    const takeover = document.querySelector("#takeover-button");
    if (takeover) takeover.hidden = Boolean(leaseToken) || state.lifecycle === "ended";
    renderRecommendations(state.recommendations);
    renderNextSteps(state.recommendations);
    if (lastRenderedRevision !== state.revision) {
      renderEvents(state.events);
      lastRenderedRevision = state.revision;
    }
  }

  function canWrite() { return canRecord && Boolean(leaseToken); }

  async function synchronize() {
    try {
      const response = await fetch(`${api}/state`, { cache: "no-store" });
      if (!response.ok) throw new Error("State request failed");
      updateState(await response.json(), true);
    } catch (_) {
      if (performance.now() - lastSuccessfulSync > 5000) {
        stale = true;
        status.textContent = "STALE — timers use last synchronized state";
        status.classList.add("stale-text");
      }
    }
  }

  async function write(url, payload) {
    if (!canWrite() || busy) return;
    busy = true;
    status.textContent = "Saving…";
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": csrfToken,
          "X-Recorder-Lease": leaseToken,
        },
        body: JSON.stringify({ ...payload, expected_revision: state.revision }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 423) {
          leaseToken = null;
          sessionStorage.removeItem(leaseKey);
        }
        throw new Error(result.error || `Save failed (${response.status}).`);
      }
      if (result.lease_token) {
        leaseToken = result.lease_token;
        sessionStorage.setItem(leaseKey, leaseToken);
      }
      updateState(result, true);
      status.textContent = "Saved · synchronized";
      return true;
    } catch (error) {
      status.textContent = `NOT SAVED — ${error.message}`;
      status.classList.add("stale-text");
      await synchronize();
      return false;
    } finally {
      busy = false;
      if (state) updateState(state);
    }
  }

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      if (action === "end") {
        document.querySelector("#end-confirm").hidden = false;
        return;
      }
      if (action === "rosc") {
        armRosc(button);
        return;
      }
      button.dataset.idempotencyKey ||= crypto.randomUUID();
      const saved = await write(`${api}/actions`, { action, details: {}, idempotency_key: button.dataset.idempotencyKey });
      if (saved) delete button.dataset.idempotencyKey;
    });
  });

  document.addEventListener("click", (event) => {
    const opener = event.target.closest("[data-open-guidance]");
    if (opener) document.getElementById(opener.dataset.openGuidance)?.showModal();
    if (event.target.matches("[data-close-guidance]")) event.target.closest("dialog")?.close();
    const rhythmChoice = event.target.closest("[data-rhythm]");
    if (rhythmChoice) {
      recordRhythm(rhythmChoice.dataset.rhythm, rhythmChoice.dataset.pulse);
      return;
    }
    const quick = event.target.closest("[data-quick]");
    if (quick) {
      quickRecord(quick.dataset);
      return;
    }
    const undo = event.target.closest("[data-undo-event-id]");
    if (undo) {
      write(`${api}/events/${encodeURIComponent(undo.dataset.undoEventId)}/undo`, {});
      return;
    }
    const nextStep = event.target.closest("[data-next-step-action]");
    if (nextStep) {
      const action = nextStep.dataset.nextStepAction;
      if (action === "pulse_check") startPulseCheck();
      else if (action === "administer_epinephrine") openEpinephrineDialog();
      else if (action === "administer_antiarrhythmic") openAntiarrhythmicDialog();
      else if (action === "record_shock") openShockDialog();
      else if (action === "rosc") {
        write(`${api}/actions`, { action: "rosc", details: {}, idempotency_key: crypto.randomUUID() });
      }
      else if (["start", "resume"].includes(action)) {
        write(`${api}/actions`, { action, details: {}, idempotency_key: crypto.randomUUID() });
      }
    }
  });

  document.querySelectorAll("[data-cancel]").forEach((button) => {
    button.addEventListener("click", () => {
      const form = document.querySelector(`#${button.dataset.cancel}-confirm`) || document.querySelector("#takeover-form");
      if (form) {
        form.hidden = true;
        form.reset?.();
        delete form.dataset.idempotencyKey;
      }
    });
  });

  async function endSession(outcome) {
    const form = document.querySelector("#end-confirm");
    const error = form.querySelector(".form-error");
    error.hidden = true;
    if (!outcome) { error.textContent = "Choose or type an end reason."; error.hidden = false; return; }
    const saved = await write(`${api}/actions`, { action: "end", details: { outcome }, idempotency_key: crypto.randomUUID() });
    if (saved) form.hidden = true;
    else { error.textContent = status.textContent; error.hidden = false; }
  }
  for (const reason of catalog.endReasons) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "button button-secondary";
    chip.textContent = reason;
    chip.addEventListener("click", () => endSession(reason));
    document.querySelector("#end-reason-chips").append(chip);
  }
  document.querySelector("#end-confirm").addEventListener("submit", (event) => {
    event.preventDefault();
    endSession(event.currentTarget.elements.outcome.value.trim());
  });

  document.querySelector("#epinephrine-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector(".form-error");
    error.hidden = true;
    const occurredAt = new Date(form.elements.occurred_at.value).toISOString();
    form.dataset.idempotencyKey ||= crypto.randomUUID();
    const saved = await write(`${api}/events`, {
      event_type: "medication_admin",
      payload: {
        title: "Epinephrine",
        dose: Number(form.elements.dose.value),
        units: "mg",
        route: form.elements.route.value,
        occurred_at: occurredAt,
        note: form.elements.note.value.trim(),
      },
      idempotency_key: form.dataset.idempotencyKey,
    });
    if (saved) {
      delete form.dataset.idempotencyKey;
      document.querySelector("#epinephrine-dialog").close();
    } else {
      error.textContent = status.textContent;
      error.hidden = false;
    }
  });

  document.querySelector("#antiarrhythmic-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector(".form-error");
    error.hidden = true;
    const agent = form.elements.agent.value;
    form.dataset.idempotencyKey ||= crypto.randomUUID();
    const saved = await write(`${api}/events`, {
      event_type: "medication_admin",
      payload: {
        title: label(agent),
        dose: Number(form.elements.dose.value),
        units: "mg",
        route: form.elements.route.value,
        occurred_at: new Date(form.elements.occurred_at.value).toISOString(),
        note: form.elements.note.value.trim(),
      },
      idempotency_key: form.dataset.idempotencyKey,
    });
    if (saved) {
      delete form.dataset.idempotencyKey;
      document.querySelector("#antiarrhythmic-dialog").close();
    } else {
      error.textContent = status.textContent;
      error.hidden = false;
    }
  });

  document.querySelector("#shock-record-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector(".form-error");
    error.hidden = true;
    form.dataset.idempotencyKey ||= crypto.randomUUID();
    const saved = await write(`${api}/events`, {
      event_type: "electrical_therapy",
      payload: {
        title: "Defibrillation",
        therapy_type: "defibrillation",
        energy_joules: Number(form.elements.energy_joules.value),
        occurred_at: new Date(form.elements.occurred_at.value).toISOString(),
        note: form.elements.note.value.trim(),
      },
      idempotency_key: form.dataset.idempotencyKey,
    });
    if (saved) {
      delete form.dataset.idempotencyKey;
      document.querySelector("#shock-record-dialog").close();
    } else {
      error.textContent = status.textContent;
      error.hidden = false;
    }
  });

  document.querySelectorAll(".category-tile").forEach((button) => {
    button.addEventListener("click", () => {
      if (!canWrite() || state?.lifecycle !== "active") return;
      const form = document.querySelector("#event-form");
      form.dataset.category = button.dataset.category;
      document.querySelector("#event-form-title").textContent = `Record ${label(button.dataset.category)}`;
      if (CHIP_CATEGORIES.includes(button.dataset.category)) {
        renderChipForm(button.dataset.category);
      } else {
        doc = { mode: "legacy", category: button.dataset.category, time: 0, customTime: "", fields: {} };
        makeFields(button.dataset.category);
      }
      setDocumentationOpen(true);
      form.querySelector("input")?.focus();
    });
  });

  document.querySelector("#cancel-event").addEventListener("click", () => {
    const form = document.querySelector("#event-form");
    form.reset();
    setDocumentationOpen(false);
    doc = null;
  });

  document.querySelector("#event-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector(".form-error");
    error.hidden = true;
    if (!doc) return;
    const occurred = occurredAt();
    if (!occurred) { error.textContent = "Enter the custom time."; error.hidden = false; return; }
    let payload;
    if (doc.mode === "chips") {
      if (!docComplete()) { error.textContent = "Complete the choices above first."; error.hidden = false; return; }
      payload = { ...doc.fields, occurred_at: occurred };
    } else {
      const fields = Object.fromEntries(new FormData(form).entries());
      let title = fields.title;
      if (form.dataset.category === "infusion") title = fields.infusion_choice === "__other__" ? fields.custom_infusion_medication : fields.infusion_choice;
      const { title: _title, infusion_choice: _infusionChoice, custom_infusion_medication: _customInfusion, custom_time: _customTime, ...rest } = fields;
      payload = { ...rest, title: (title || "").trim(), occurred_at: occurred };
      for (const [key, value] of Object.entries(payload)) if (value === "") delete payload[key];
    }
    const saved = await write(`${api}/events`, {
      event_type: form.dataset.category,
      payload,
      idempotency_key: crypto.randomUUID(),
    });
    if (saved) { form.reset(); setDocumentationOpen(false); doc = null; }
    else { error.textContent = status.textContent; error.hidden = false; }
  });

  document.querySelector("#takeover-button")?.addEventListener("click", () => {
    document.querySelector("#takeover-form").hidden = false;
  });

  async function takeOver(reason) {
    const form = document.querySelector("#takeover-form");
    const fieldError = form.querySelector(".form-error");
    fieldError.hidden = true;
    if (busy || !state) return;
    if (reason.length < 4) { fieldError.textContent = "Choose or type a reason."; fieldError.hidden = false; return; }
    busy = true;
    status.textContent = "Taking over recorder lease…";
    try {
      const response = await fetch(`${api}/takeover`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken },
        body: JSON.stringify({ reason, expected_revision: state.revision }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Takeover failed (${response.status}).`);
      leaseToken = result.lease_token;
      sessionStorage.setItem(leaseKey, leaseToken);
      status.textContent = "Recorder lease taken over · audited";
      form.hidden = true;
      await synchronize();
    } catch (error) {
      status.textContent = `Takeover failed — ${error.message}`;
      fieldError.textContent = status.textContent;
      fieldError.hidden = false;
    } finally {
      busy = false;
      if (state) updateState(state);
    }
  }
  const takeoverChips = document.querySelector("#takeover-reason-chips");
  if (takeoverChips) {
    for (const reason of catalog.takeoverReasons) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "button button-secondary";
      chip.textContent = reason;
      chip.addEventListener("click", () => takeOver(reason));
      takeoverChips.append(chip);
    }
    document.querySelector("#takeover-form").addEventListener("submit", (event) => {
      event.preventDefault();
      takeOver(event.currentTarget.elements.reason.value.trim());
    });
  }

  function tick() {
    if (!state) return;
    const elapsed = state.started_at ? Math.max(0, ((state.ended_at ? Date.parse(state.ended_at) : nowEpochMs()) - Date.parse(state.started_at)) / 1000) : 0;
    document.querySelector("#elapsed-timer").textContent = formatClock(elapsed);
    if (state.compression_status === "running" && state.compression_anchor_at) {
      const cycleElapsed = elapsedFrom(state.compression_anchor_at);
      document.querySelector("#cycle-timer").textContent = state.workflow === "cardiac_arrest" ? formatDuration(Math.max(0, 120 - cycleElapsed)) : formatDuration(cycleElapsed);
      const pulseOverdue = state.workflow === "cardiac_arrest" && cycleElapsed >= 120;
      document.querySelector("#compression-state").textContent = pulseOverdue ? `Pulse check due · overdue ${formatDuration(cycleElapsed - 120)}` : label(state.compression_status);
      document.querySelector("#compression-state").classList.toggle("pulse-overdue", pulseOverdue);
    } else if (state.compression_status === "held" && state.hold_anchor_at) {
      const pauseDuration = elapsedFrom(state.hold_anchor_at);
      document.querySelector("#cycle-timer").textContent = formatDuration(pauseDuration);
      document.querySelector("#compression-state").textContent = `Compressions held · pause ${formatDuration(pauseDuration)}`;
      document.querySelector("#compression-state").classList.remove("pulse-overdue");
    } else {
      document.querySelector("#cycle-timer").textContent = "—";
    }
    updateStepCountdowns();
    maybeRequestResuscitationSummary();
    if (stale) status.textContent = "STALE — timers use last synchronized state";
  }

  async function loadAiSummary() {
    const show = (id, visible) => { document.querySelector(id).hidden = !visible; };
    let result = { status: "unavailable" };
    try {
      const response = await fetch(`${api}/ai-summary`, { headers: { Accept: "application/json" } });
      if (response.ok) result = await response.json();
    } catch (error) {
      result = { status: "unavailable" };
    }
    if (result.status === "pending") {
      window.setTimeout(loadAiSummary, 2000);
      return;
    }
    show("#ai-summary-pending", false);
    show("#ai-summary-unavailable", result.status !== "ready");
    show("#ai-summary-ready", result.status === "ready");
    if (result.status !== "ready") return;
    document.querySelector("#ai-summary-text").textContent = result.summary;
    document.querySelector("#ai-summary-source").textContent = result.provider === "mock" ? "Mock AI output (no model called)." : `Generated by ${result.model}.`;
    const list = document.querySelector("#ai-cause-list");
    list.replaceChildren();
    for (const cause of result.causes) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link-button";
      button.textContent = cause.name;
      button.addEventListener("click", () => {
        document.querySelector("#ai-cause-title").textContent = cause.name;
        document.querySelector("#ai-cause-rationale").textContent = cause.rationale;
        document.querySelector("#ai-cause-check").textContent = cause.bedside_check;
        document.querySelector("#ai-cause-treatment").textContent = cause.treatment;
        document.querySelector("#ai-cause-dialog").showModal();
      });
      const rationale = document.createElement("span");
      rationale.textContent = ` — ${cause.rationale}`;
      item.append(button, rationale);
      list.append(item);
    }
  }

  async function loadResuscitationSummary() {
    if (resuscitationStatusInFlight) return;
    resuscitationStatusInFlight = true;
    try {
      const response = await fetch(`${api}/ai-resuscitation-summary`, { cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const result = await response.json();
      if (Number.isInteger(result.checkpoint_index)) {
        lastResuscitationCheckpoint = Math.max(lastResuscitationCheckpoint, result.checkpoint_index);
      }
      if (result.is_final) document.querySelector("#ai-resuscitation-title").textContent = "Final resuscitation summary";
      const pending = document.querySelector("#ai-resuscitation-pending");
      const unavailable = document.querySelector("#ai-resuscitation-unavailable");
      const facts = document.querySelector("#ai-resuscitation-facts");
      const generatedAt = document.querySelector("#ai-resuscitation-time");
      const source = document.querySelector("#ai-resuscitation-source");
      pending.hidden = result.status !== "pending" && result.status !== "waiting";
      unavailable.hidden = result.status !== "unavailable";
      facts.hidden = result.status !== "ready";
      source.hidden = result.status !== "ready";
      if (result.status === "waiting") {
        pending.textContent = state?.lifecycle === "ended"
          ? "The final update will be generated when the initial patient-history summary is ready."
          : "A status update will be generated after the first two minutes of cardiac arrest.";
      } else if (result.status === "pending") {
        pending.textContent = "Generating the latest status update…";
      } else if (result.status === "ready") {
        const summary = result.summary;
        facts.replaceChildren();
        const addFact = (title, value, entries = null) => {
          const item = document.createElement("li");
          const heading = document.createElement("strong");
          heading.textContent = `${title}: `;
          item.append(heading);
          if (entries) {
            const list = document.createElement("ul");
            for (const entry of entries) {
              const child = document.createElement("li");
              child.textContent = entry;
              list.append(child);
            }
            if (!entries.length) {
              const empty = document.createElement("li");
              empty.textContent = "None documented";
              list.append(empty);
            }
            item.append(list);
          } else {
            item.append(document.createTextNode(value));
          }
          facts.append(item);
        };
        addFact("Completed CPR rounds", String(summary.rounds_completed));
        const rhythmEntries = [`Initial rhythm: ${summary.initial_rhythm}`, ...(summary.rounds || []).map((round) => `Round ${round.round}: ${round.rhythm}`)];
        addFact("Rhythm by round", "", rhythmEntries);
        addFact("Airway", summary.airway_status);
        addFact("Vascular access", "", summary.vascular_access || []);
        addFact("Medications given", "", (summary.medications || []).map((medication) => `${medication.medication} — ${medication.dose} ${medication.units} × ${medication.count}`));
        generatedAt.textContent = result.generated_at ? `Updated ${formatTime(result.generated_at)}` : "";
        source.textContent = result.provider === "mock" ? "Mock output (no model was called)." : `Generated by ${result.model || "the configured model"}.`;
      }
    } catch (_) {
      // Keep the last displayed update if a status poll fails.
    } finally {
      resuscitationStatusInFlight = false;
    }
  }

  async function maybeRequestResuscitationSummary() {
    if (!canWrite() || resuscitationRequestInFlight || !state || state.workflow !== "cardiac_arrest") return;
    const final = state.lifecycle === "ended";
    if (final && finalResuscitationRequested) return;
    if (!final && state.lifecycle !== "active") return;
    const arrestStart = state.events.find((event) => event.type === "cardiac_arrest_started")?.occurred_at || state.started_at;
    if (!arrestStart) return;
    const dueCheckpoint = Math.floor(elapsedFrom(arrestStart) / 120);
    if ((!final && (dueCheckpoint < 1 || dueCheckpoint <= lastResuscitationCheckpoint)) || performance.now() < resuscitationRetryAt) return;
    resuscitationRequestInFlight = true;
    try {
      const response = await fetch(`${api}/ai-resuscitation-summary`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": csrfToken,
          "X-Recorder-Lease": leaseToken || "",
        },
        body: JSON.stringify({ final }),
      });
      const result = await response.json();
      if (!response.ok || result.status === "waiting") {
        resuscitationRetryAt = performance.now() + 5000;
        return;
      }
      if (final) finalResuscitationRequested = true;
      else lastResuscitationCheckpoint = Math.max(lastResuscitationCheckpoint, result.checkpoint_index || dueCheckpoint);
      await loadResuscitationSummary();
    } catch (_) {
      resuscitationRetryAt = performance.now() + 5000;
    } finally {
      resuscitationRequestInFlight = false;
    }
  }

  loadAiSummary();
  loadResuscitationSummary();
  synchronize();
  window.setInterval(synchronize, 1000);
  window.setInterval(tick, 200);
  window.setInterval(loadResuscitationSummary, 2000);
})();
