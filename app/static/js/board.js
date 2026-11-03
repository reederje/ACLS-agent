(() => {
  const sessionId = document.querySelector("meta[name='session-id']").content;
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/state`;
  let serverEpochMs = 0;
  let syncMark = 0;
  let sessionState = null;
  let lastSync = 0;
  let stale = true;
  const pad = (value) => String(value).padStart(2, "0");
  const currentEpoch = () => serverEpochMs + performance.now() - syncMark;
  const clock = (seconds) => {
    const value = Math.max(0, Math.floor(seconds));
    return `${pad(Math.floor(value / 3600))}:${pad(Math.floor((value % 3600) / 60))}:${pad(value % 60)}`;
  };
  const duration = (seconds) => {
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${pad(value % 60)}`;
  };
  const elapsedFrom = (time) => time ? Math.max(0, (currentEpoch() - Date.parse(time)) / 1000) : 0;
  const pretty = (value) => String(value || "").replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
  const rhythmLabel = (value) => ({ vf: "VF", vt: "VT", pea: "PEA", rosc: "ROSC" })[value] || pretty(value);
  const localTime = (time) => time ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }) : "—";

  function renderActionItems(steps) {
    const list = document.querySelector("#board-action-items");
    const visibleSteps = steps.filter((step) => !step.due_at || (Date.parse(step.due_at) - currentEpoch()) / 1000 <= 60);
    const visibleIds = new Set(visibleSteps.map((step) => step.id));
    list.querySelectorAll(".board-action-chip").forEach((chip) => {
      if (!visibleIds.has(chip.dataset.stepId)) chip.remove();
    });
    for (const step of visibleSteps) {
      let chip = list.querySelector(`[data-step-id="${CSS.escape(step.id)}"]`);
      if (!chip) {
        chip = document.createElement("span");
        chip.className = "board-action-chip";
        chip.dataset.stepId = step.id;
        chip.setAttribute("role", "listitem");
        list.append(chip);
      }
      chip.dataset.title = step.title || "Action item";
      chip.dataset.dueAt = step.due_at || "";
      chip.dataset.overdueAt = step.overdue_at || "";
    }
    let empty = list.querySelector("[data-action-empty]");
    if (!visibleSteps.length && !empty) {
      empty = document.createElement("span");
      empty.dataset.actionEmpty = "";
      empty.className = "muted";
      empty.setAttribute("role", "listitem");
      list.append(empty);
    } else if (visibleSteps.length && empty) {
      empty.remove();
    }
    if (empty && !visibleSteps.length) empty.textContent = "No action items due within the next minute.";
    updateActionItems();
  }

  function updateActionItems() {
    const now = currentEpoch();
    document.querySelectorAll(".board-action-chip").forEach((chip) => {
      const dueAt = chip.dataset.dueAt ? Date.parse(chip.dataset.dueAt) : null;
      const overdueAt = chip.dataset.overdueAt ? Date.parse(chip.dataset.overdueAt) : null;
      let status;
      let timing;
      let stateClass;
      if (dueAt === null || Number.isNaN(dueAt)) {
        status = "Ready";
        timing = "No timer";
        stateClass = "is-untimed";
      } else if (now < dueAt) {
        status = "Upcoming";
        timing = `in ${duration(Math.ceil((dueAt - now) / 1000))}`;
        stateClass = "is-upcoming";
      } else if (overdueAt !== null && !Number.isNaN(overdueAt) && now >= overdueAt) {
        status = "Overdue";
        timing = `by ${duration(Math.floor((now - overdueAt) / 1000))}`;
        stateClass = "is-overdue";
      } else {
        status = "Due";
        timing = overdueAt !== null && !Number.isNaN(overdueAt)
          ? `· overdue in ${duration(Math.ceil((overdueAt - now) / 1000))}`
          : "now";
        stateClass = "is-due";
      }
      if (chip.className !== `board-action-chip ${stateClass}`) chip.className = `board-action-chip ${stateClass}`;
      const text = `${status} · ${chip.dataset.title} · ${timing}`;
      if (chip.textContent !== text) chip.textContent = text;
      const ariaLabel = `${status}: ${chip.dataset.title}, ${timing}`;
      if (chip.getAttribute("aria-label") !== ariaLabel) chip.setAttribute("aria-label", ariaLabel);
    });
  }

  function renderTimeline(events) {
    const list = document.querySelector("#board-events");
    const offset = list.scrollTop;
    list.replaceChildren();
    for (const event of events.slice(-12).reverse()) {
      const row = document.createElement("li");
      row.className = "event-item";
      const header = document.createElement("div");
      header.className = "event-heading";
      const type = document.createElement("strong");
      type.textContent = pretty(event.type);
      const time = document.createElement("time");
      time.textContent = localTime(event.occurred_at);
      header.append(type, time);
      const detail = document.createElement("p");
      detail.textContent = Object.entries(event.payload || {}).map(([key, value]) => `${pretty(key)}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ");
      row.append(header, detail);
      list.append(row);
    }
    if (!events.length) {
      const empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "No events documented.";
      list.append(empty);
    }
    list.scrollTop = offset;
  }

  function updateNextTimerCue() {
    let text = sessionState?.recommendations?.summary || "No recommendation available";
    if (sessionState?.workflow === "cardiac_arrest" && sessionState.compression_status === "running" && sessionState.compression_anchor_at) {
      const cycleElapsed = elapsedFrom(sessionState.compression_anchor_at);
      if (cycleElapsed >= 120) text = `Pulse check due · overdue ${duration(cycleElapsed - 120)} (documentation prompt only)`;
    }
    document.querySelector("#board-next").textContent = text;
  }

  function apply(state, successfulSync) {
    sessionState = state;
    if (successfulSync) {
      serverEpochMs = Date.parse(state.server_time);
      syncMark = performance.now();
      lastSync = syncMark;
      stale = false;
    }
    const patient = state.patient;
    const demographics = patient.demographics || {};
    document.querySelector("#board-patient").textContent = `${patient.display_name} · ${patient.patient_id}`;
    document.querySelector("#board-demographics").textContent = `${demographics.age_display} · ${pretty(demographics.population)} · ${pretty(state.workflow)}`;
    document.querySelector("#board-weight").textContent = demographics.weight_kg ? `${demographics.weight_kg} kg · ${pretty(demographics.weight_provenance)}` : "Not recorded";
    document.querySelector("#board-code").textContent = demographics.code_status || "Unknown";
    document.querySelector("#board-workflow").textContent = pretty(state.workflow);
    document.querySelector("#board-lifecycle").textContent = `${pretty(state.lifecycle)}${state.outcome ? ` · ${pretty(state.outcome)}` : ""}`;
    const assessment = state.rhythm_assessment;
    document.querySelector("#board-rhythm").textContent = assessment ? rhythmLabel(assessment.rhythm) : "Unknown";
    document.querySelector("#board-pulse").textContent = assessment ? `Pulse ${pretty(assessment.pulse)}${assessment.heart_rate_bpm ? ` · ${assessment.heart_rate_bpm} bpm` : ""}` : "Pulse unknown";
    document.querySelector("#board-compression").textContent = pretty(state.compression_status);
    document.querySelector("#board-guidance").textContent = state.recommendations?.status === "not_applicable" ? "No recommendation for this pathway" : `Advisory only · ${state.recommendations?.ruleset_version || "ruleset unavailable"} · synthetic simulation`;
    renderActionItems(state.recommendations?.next_steps || []);
    renderTimeline(state.events);
    if (successfulSync) {
      document.querySelector("#board-sync").textContent = `Synchronized ${new Date(serverEpochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" })}`;
      document.querySelector("#stale-label").hidden = true;
    }
    updateNextTimerCue();
  }

  async function synchronize() {
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error(`Sync failed (${response.status})`);
      apply(await response.json(), true);
    } catch (_) {
      if (performance.now() - lastSync >= 5000) {
        stale = true;
        document.querySelector("#stale-label").hidden = false;
        document.querySelector("#board-sync").textContent = "Connection lost";
      }
    }
  }

  function tick() {
    updateActionItems();
    updateNextTimerCue();
    if (sessionState?.started_at) {
      const endpoint = sessionState.ended_at ? Date.parse(sessionState.ended_at) : currentEpoch();
      document.querySelector("#board-elapsed").textContent = clock(Math.max(0, (endpoint - Date.parse(sessionState.started_at)) / 1000));
    }
    if (sessionState?.compression_status === "running" && sessionState.compression_anchor_at) {
      const cycleElapsed = elapsedFrom(sessionState.compression_anchor_at);
      document.querySelector("#board-cycle").textContent = sessionState.workflow === "cardiac_arrest" ? duration(Math.max(0, 120 - cycleElapsed)) : duration(cycleElapsed);
    } else if (sessionState?.compression_status === "held" && sessionState.hold_anchor_at) {
      document.querySelector("#board-cycle").textContent = duration(elapsedFrom(sessionState.hold_anchor_at));
    } else {
      document.querySelector("#board-cycle").textContent = "—";
    }
    if (stale && performance.now() - lastSync >= 5000) document.querySelector("#stale-label").hidden = false;
  }

  synchronize();
  window.setInterval(synchronize, 1000);
  window.setInterval(tick, 200);
})();
