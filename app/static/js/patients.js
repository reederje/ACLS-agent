(() => {
  const rows = [...document.querySelectorAll(".patient-row")];
  const workflowButtons = [...document.querySelectorAll(".workflow-button")];
  const selectedLabel = document.querySelector("#selected-patient-label");
  const acknowledgmentLabel = document.querySelector("#code-status-ack-label");
  const acknowledgment = document.querySelector("#code-status-acknowledged");
  const error = document.querySelector("#create-session-error");
  let selectedRow = null;
  let creating = false;

  function updateButtons() {
    const needsAck = selectedRow?.dataset.needsAck === "true";
    const enabled = Boolean(selectedRow) && !creating && (!needsAck || acknowledgment.checked);
    workflowButtons.forEach((button) => { button.disabled = !enabled; });
  }

  function selectRow(row) {
    selectedRow = row;
    for (const item of rows) {
      const selected = item === row;
      item.classList.toggle("patient-row-selected", selected);
      item.querySelector(".patient-row-radio").checked = selected;
    }
    selectedLabel.textContent = `Selected patient: ${row.dataset.patientName} (${row.dataset.patientId}) — tap a workflow to start.`;
    acknowledgmentLabel.hidden = row.dataset.needsAck !== "true";
    acknowledgment.checked = false;
    workflowButtons.forEach((button) => button.classList.toggle("is-suggested", button.dataset.workflow === row.dataset.suggestedWorkflow));
    error.hidden = true;
    updateButtons();
  }

  rows.forEach((row) => {
    row.addEventListener("click", () => selectRow(row));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRow(row);
      }
    });
  });
  acknowledgment.addEventListener("change", updateButtons);

  workflowButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      if (!selectedRow || creating) return;
      error.hidden = true;
      creating = true;
      updateButtons();
      try {
        const response = await fetch("/api/sessions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRFToken": document.querySelector("meta[name='csrf-token']").content,
          },
          body: JSON.stringify({
            patient_id: selectedRow.dataset.patientId,
            workflow: button.dataset.workflow,
            code_status_acknowledged: acknowledgment.checked,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Session could not be created.");
        sessionStorage.setItem(`recorder-lease:${result.session_id}`, result.lease_token);
        window.location.assign(`/sessions/${encodeURIComponent(result.session_id)}`);
      } catch (reason) {
        error.textContent = reason.message;
        error.hidden = false;
        creating = false;
        updateButtons();
      }
    });
  });
})();
