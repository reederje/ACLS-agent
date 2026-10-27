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

  function apply(state, successfulSync) {
    sessionState = state;
    const patient = state.patient;
    const demographics = patient.demographics || {};
    document.querySelector("#board-patient").textContent = `${patient.display_name} · ${patient.patient_id}`;
    document.querySelector("#board-demographics").textContent = `${demographics.age_display} · ${pretty(demographics.population)} · ${pretty(state.workflow)}`;
    document.querySelector("#board-weight").textContent = demographics.weight_kg ? `${demographics.weight_kg} kg · ${pretty(demographics.weight_provenance)}` : "Not recorded";
    document.querySelector("#board-code").textContent = demographics.code_status || "Unknown";
    document.querySelector("#board-workflow").textContent = pretty(state.workflow);
    document.querySelector("#board-lifecycle").textContent = `${pretty(state.lifecycle)}${state.outcome ? ` · ${pretty(state.outcome)}` : ""}`;
    const assessment = state.rhythm_assessment;
    document.querySelector("#board-rhythm").textContent = assessment ? rhythmLabel(assessment.rhythm) : "Not assessed";
    document.querySelector("#board-pulse").textContent = assessment ? `Pulse ${pretty(assessment.pulse)}${assessment.heart_rate_bpm ? ` · ${assessment.heart_rate_bpm} bpm` : ""}` : "Pulse unknown";
    document.querySelector("#board-compression").textContent = pretty(state.compression_status);
    document.querySelector("#board-next").textContent = state.recommendations?.summary || "No recommendation available";
    document.querySelector("#board-guidance").textContent = state.recommendations?.status === "not_applicable" ? "No recommendation for this pathway" : `Advisory only · ${state.recommendations?.ruleset_version || "ruleset unavailable"} · synthetic simulation`;
    renderTimeline(state.events);
    if (successfulSync) {
      serverEpochMs = Date.parse(state.server_time);
      syncMark = performance.now();
      lastSync = syncMark;
      stale = false;
      document.querySelector("#board-sync").textContent = `Synchronized ${new Date(serverEpochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" })}`;
      document.querySelector("#stale-label").hidden = true;
    }
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
    if (sessionState?.started_at) {
      const endpoint = sessionState.ended_at ? Date.parse(sessionState.ended_at) : currentEpoch();
      document.querySelector("#board-elapsed").textContent = clock(Math.max(0, (endpoint - Date.parse(sessionState.started_at)) / 1000));
    }
    if (sessionState?.compression_status === "running" && sessionState.compression_anchor_at) {
      const cycleElapsed = elapsedFrom(sessionState.compression_anchor_at);
      document.querySelector("#board-cycle").textContent = sessionState.workflow === "cardiac_arrest" ? duration(Math.max(0, 120 - cycleElapsed)) : duration(cycleElapsed);
      if (sessionState.workflow === "cardiac_arrest" && cycleElapsed >= 120) document.querySelector("#board-next").textContent = `Pulse check due · overdue ${duration(cycleElapsed - 120)} (documentation prompt only)`;
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
