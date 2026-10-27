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

  function makeFields(category) {
    const holder = document.querySelector("#event-fields");
    holder.replaceChildren();
    if (category === "medication_admin") {
      const medicationLabel = document.createElement("label");
      medicationLabel.textContent = "Medication given";
      const medicationSelect = document.createElement("select");
      medicationSelect.name = "medication_choice";
      medicationSelect.required = true;
      medicationSelect.innerHTML = `
        <option value="" disabled selected>Select medication…</option>
        <optgroup label="Adult ACLS algorithm medications">
          <option>Epinephrine</option>
          <option>Amiodarone</option>
          <option>Lidocaine</option>
          <option>Atropine</option>
          <option>Adenosine</option>
          <option>Procainamide</option>
          <option>Sotalol</option>
        </optgroup>
        <optgroup label="Indication-specific / reversible-cause documentation (not routine ACLS drugs)">
          <option>Magnesium sulfate</option>
          <option>Sodium bicarbonate</option>
          <option>Calcium gluconate</option>
          <option>Calcium chloride</option>
          <option>Dextrose 5% (D5)</option>
          <option>Dextrose 10% (D10)</option>
          <option>Dextrose 25% (D25)</option>
          <option>Dextrose 50% (D50)</option>
          <option>Naloxone</option>
        </optgroup>
        <option value="__other__">Other medication…</option>`;
      const customMedication = input("custom_medication", "Enter other medication", "text", false);
      customMedication.hidden = true;
      medicationLabel.append(medicationSelect);
      holder.append(medicationLabel, customMedication);
      medicationSelect.addEventListener("change", () => {
        const isOther = medicationSelect.value === "__other__";
        customMedication.hidden = !isOther;
        customMedication.querySelector("input").required = isOther;
        if (isOther) customMedication.querySelector("input").focus();
      });
      const notice = document.createElement("p");
      notice.className = "muted medication-catalog-note";
      notice.textContent = "Documentation choices only—not treatment recommendations. Enter the actual dose, units, and route given. No dose or route is preselected.";
      holder.append(notice);
      holder.append(input("dose", "Actual dose given", "number", true));
      holder.append(input("units", "Dose units", "text", true, "e.g., mg"));
      holder.append(input("route", "Route", "text", true, "Enter documented route"));
      holder.append(input("note", "Optional note"));
    } else if (category === "infusion") {
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
    holder.append(input("occurred_at", "Occurrence time (local; defaults to now)", "datetime-local"));
  }

  function renderEvents(events) {
    const list = document.querySelector("#event-list");
    const previousScroll = list.scrollTop;
    const wasAtTop = previousScroll < 12;
    list.replaceChildren();
    for (const event of events) {
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
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button button-primary next-step-button";
        button.dataset.nextStepAction = step.action;
        button.dataset.stepId = step.id;
        button.textContent = ({
          start: state?.workflow === "cardiac_arrest" ? "Start code" : "Start session",
          pulse_check: state?.compression_status === "held" ? "Document rhythm and pulse" : "Start pulse check",
          administer_epinephrine: "Administer epinephrine",
          administer_antiarrhythmic: "Administer antiarrhythmic",
          record_shock: "Record shock",
          resume: "Resume compressions",
          rosc: "Record ROSC",
        })[step.action] || "Start action";
        button.disabled = !canWrite();
        card.append(content, button);
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
      const button = card.querySelector(".next-step-button");
      card.classList.remove("is-due-soon", "is-due", "is-overdue");
      button.classList.remove("button-danger");
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
        button.classList.add("button-danger");
      } else if (overdueAt) {
        const untilOverdue = Math.max(0, Math.ceil((overdueAt - now) / 1000));
        countdown.textContent = `Due now · overdue in: ${untilOverdue} seconds`;
        card.classList.add("is-due");
      } else {
        countdown.textContent = "Due now";
        card.classList.add("is-due");
      }
      button.disabled = !canWrite();
    });
    cards.sort((left, right) => compareStepUrgency(left, right, now));
    const container = document.querySelector("#next-step-list");
    cards.forEach((card) => container.append(card));
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
    if (state?.compression_status === "held") {
      rhythmForm.reset();
      updatePulseChoice();
      document.querySelector("#rhythm-save-error").hidden = true;
      document.querySelector("#pulse-check-dialog").showModal();
      document.querySelector("#rhythm-form select[name='rhythm']").focus();
    }
  }

  function updateState(snapshot, synchronized = false) {
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
    document.querySelector("#cycle-caption").textContent = isArrest ? "Compression cycle" : state.compression_status === "running" ? "CPR elapsed" : "Compression-cycle timer";
    const assessment = state.rhythm_assessment;
    document.querySelector("#rhythm-state").textContent = assessment ? `${rhythmLabel(assessment.rhythm)} · pulse ${label(assessment.pulse)}` : "Not assessed";
    document.querySelector("#rhythm-details").textContent = assessment ? "Assessment recorded" : "No assessment recorded";
    document.querySelectorAll(".category-tile").forEach((button) => { button.disabled = !active || !canWrite(); });
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
        document.querySelector("#end-reason").focus();
        return;
      }
      if (action === "rosc") {
        document.querySelector("#rosc-confirm").hidden = false;
        document.querySelector("#confirm-rosc").focus();
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
    const nextStep = event.target.closest("[data-next-step-action]");
    if (nextStep) {
      const action = nextStep.dataset.nextStepAction;
      if (action === "pulse_check") startPulseCheck();
      else if (action === "administer_epinephrine") openEpinephrineDialog();
      else if (action === "administer_antiarrhythmic") openAntiarrhythmicDialog();
      else if (action === "record_shock") openShockDialog();
      else if (action === "rosc") {
        document.querySelector(".secondary-controls").open = true;
        document.querySelector("#rosc-confirm").hidden = false;
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

  document.querySelector("#end-confirm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    form.dataset.idempotencyKey ||= crypto.randomUUID();
    const saved = await write(`${api}/actions`, {
      action: "end",
      details: { outcome: form.elements.outcome.value.trim() },
      idempotency_key: form.dataset.idempotencyKey,
    });
    if (saved) { delete form.dataset.idempotencyKey; form.hidden = true; }
    else { const error = form.querySelector(".form-error"); error.textContent = status.textContent; error.hidden = false; }
  });

  document.querySelector("#confirm-rosc").addEventListener("click", async () => {
    const button = document.querySelector("#confirm-rosc");
    button.dataset.idempotencyKey ||= crypto.randomUUID();
    const saved = await write(`${api}/actions`, { action: "rosc", details: {}, idempotency_key: button.dataset.idempotencyKey });
    if (saved) { delete button.dataset.idempotencyKey; document.querySelector("#rosc-confirm").hidden = true; }
  });

  const rhythmForm = document.querySelector("#rhythm-form");
  const rhythmSelect = rhythmForm.elements.rhythm;
  const pulseField = document.querySelector("#pulse-choice-field");
  const pulseSelect = rhythmForm.elements.pulse;
  const impliedPulse = { vf: "absent", pea: "absent", asystole: "absent", rosc: "present" };
  const updatePulseChoice = () => {
    const pulseIsRequired = rhythmSelect.value === "vt";
    pulseField.hidden = !pulseIsRequired;
    pulseSelect.required = pulseIsRequired;
    if (!pulseIsRequired) pulseSelect.value = "";
  };
  rhythmSelect.addEventListener("change", updatePulseChoice);

  rhythmForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = document.querySelector("#rhythm-save-error");
    error.hidden = true;
    form.dataset.idempotencyKey ||= crypto.randomUUID();
    const rhythm = rhythmSelect.value;
    const details = { rhythm, pulse: rhythm === "vt" ? pulseSelect.value : impliedPulse[rhythm] };
    const saved = await write(`${api}/actions`, {
      action: "rhythm_assessment",
      details,
      idempotency_key: form.dataset.idempotencyKey,
    });
    if (saved) {
      delete form.dataset.idempotencyKey;
      form.reset();
      updatePulseChoice();
      document.querySelector("#pulse-check-dialog").close();
    } else {
      error.textContent = status.textContent;
      error.hidden = false;
    }
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
      makeFields(button.dataset.category);
      form.hidden = false;
      form.querySelector("input")?.focus();
    });
  });

  document.querySelector("#cancel-event").addEventListener("click", () => {
    const form = document.querySelector("#event-form");
    form.reset();
    form.hidden = true;
  });

  document.querySelector("#event-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form).entries());
    const occurredAt = fields.occurred_at ? new Date(fields.occurred_at).toISOString() : new Date(nowEpochMs()).toISOString();
    let title = fields.title;
    if (form.dataset.category === "medication_admin") {
      title = fields.medication_choice === "__other__" ? fields.custom_medication : fields.medication_choice;
    } else if (form.dataset.category === "infusion") {
      title = fields.infusion_choice === "__other__" ? fields.custom_infusion_medication : fields.infusion_choice;
    }
    const { title: _title, medication_choice: _choice, custom_medication: _custom, infusion_choice: _infusionChoice, custom_infusion_medication: _customInfusion, occurred_at: _, ...payload } = fields;
    payload.title = title.trim();
    payload.occurred_at = occurredAt;
    for (const [key, value] of Object.entries(payload)) if (value === "") delete payload[key];
    const error = form.querySelector(".form-error");
    error.hidden = true;
    form.dataset.idempotencyKey ||= crypto.randomUUID();
    const saved = await write(`${api}/events`, {
      event_type: form.dataset.category,
      payload,
      idempotency_key: form.dataset.idempotencyKey,
    });
    if (saved) { delete form.dataset.idempotencyKey; form.reset(); form.hidden = true; }
    else { error.textContent = status.textContent; error.hidden = false; }
  });

  document.querySelector("#takeover-button")?.addEventListener("click", () => {
    const form = document.querySelector("#takeover-form");
    form.hidden = false;
    document.querySelector("#takeover-reason").focus();
  });

  document.querySelector("#takeover-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (busy || !state) return;
    busy = true;
    status.textContent = "Taking over recorder lease…";
    try {
      const response = await fetch(`${api}/takeover`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken },
        body: JSON.stringify({ reason: form.elements.reason.value.trim(), expected_revision: state.revision }),
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
      const fieldError = form.querySelector(".form-error");
      fieldError.textContent = status.textContent;
      fieldError.hidden = false;
    } finally {
      busy = false;
      if (state) updateState(state);
    }
  });

  function tick() {
    if (!state) return;
    const elapsed = state.started_at ? Math.max(0, ((state.ended_at ? Date.parse(state.ended_at) : nowEpochMs()) - Date.parse(state.started_at)) / 1000) : 0;
    document.querySelector("#elapsed-timer").textContent = formatClock(elapsed);
    if (state.compression_status === "running" && state.compression_anchor_at) {
      const cycleElapsed = elapsedFrom(state.compression_anchor_at);
      document.querySelector("#cycle-timer").textContent = state.workflow === "cardiac_arrest" ? formatDuration(Math.max(0, 120 - cycleElapsed)) : formatDuration(cycleElapsed);
      document.querySelector("#compression-state").textContent = state.workflow === "cardiac_arrest" && cycleElapsed >= 120 ? `Pulse check due · overdue ${formatDuration(cycleElapsed - 120)}` : label(state.compression_status);
    } else if (state.compression_status === "held" && state.hold_anchor_at) {
      const pauseDuration = elapsedFrom(state.hold_anchor_at);
      document.querySelector("#cycle-timer").textContent = formatDuration(pauseDuration);
      document.querySelector("#compression-state").textContent = `Compressions held · pause ${formatDuration(pauseDuration)}`;
    } else {
      document.querySelector("#cycle-timer").textContent = "—";
    }
    updateStepCountdowns();
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

  loadAiSummary();
  synchronize();
  window.setInterval(synchronize, 1000);
  window.setInterval(tick, 200);
})();
