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
  let lastSuccessfulSync = 0;
  const status = document.querySelector("#save-status");
  const csrfToken = document.querySelector("meta[name='csrf-token']").content;
  const api = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const label = (value) => String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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
    document.querySelector("#compression-state").textContent = label(state.compression_status);
    document.querySelector("#cycle-caption").textContent = isArrest ? "Compression cycle · 2-minute simulation interval" : state.compression_status === "running" ? "CPR elapsed · no arrest cycle" : "Compression-cycle timer";
    const assessment = state.rhythm_assessment;
    document.querySelector("#rhythm-state").textContent = assessment ? `${label(assessment.rhythm)} · pulse ${label(assessment.pulse)}` : "Not assessed";
    document.querySelector("#rhythm-details").textContent = assessment ? "Assessment recorded" : "No assessment recorded";
    const pause = state.compression_status === "held";
    document.querySelector("#assessment-box").hidden = !pause;
    document.querySelector("#pulse-check-due").hidden = !isArrest || state.compression_status !== "running" || elapsedFrom(state.compression_anchor_at) < 120;
    document.querySelectorAll(".category-tile").forEach((button) => { button.disabled = !active || !canWrite(); });
    const writer = canWrite();
    document.querySelectorAll("#ready-actions button, #active-actions button, #assessment-box button").forEach((button) => { button.disabled = !writer || busy; });
    const takeover = document.querySelector("#takeover-button");
    if (takeover) takeover.hidden = Boolean(leaseToken) || state.lifecycle === "ended";
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

  document.querySelector("#rhythm-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = document.querySelector("#rhythm-save-error");
    error.hidden = true;
    form.dataset.idempotencyKey ||= crypto.randomUUID();
    const data = new FormData(form);
    const details = { rhythm: data.get("rhythm"), pulse: data.get("pulse") };
    const saved = await write(`${api}/actions`, {
      action: "rhythm_assessment",
      details,
      idempotency_key: form.dataset.idempotencyKey,
    });
    if (saved) {
      delete form.dataset.idempotencyKey;
      form.reset();
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
      document.querySelector("#cycle-timer").textContent = formatDuration(elapsedFrom(state.hold_anchor_at));
      document.querySelector("#compression-state").textContent = "Compressions held · pause duration";
    } else {
      document.querySelector("#cycle-timer").textContent = "—";
    }
    if (stale) status.textContent = "STALE — timers use last synchronized state";
  }

  synchronize();
  window.setInterval(synchronize, 1000);
  window.setInterval(tick, 200);
})();
