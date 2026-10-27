(() => {
  const rows = [...document.querySelectorAll(".patient-row")];
  const workflow = document.querySelector("#workflow-select");
  const selectedLabel = document.querySelector("#selected-patient-label");
  const acknowledgmentLabel = document.querySelector("#code-status-ack-label");
  const acknowledgment = document.querySelector("#code-status-acknowledged");
  const button = document.querySelector("#create-session-button");
  const error = document.querySelector("#create-session-error");
  let selectedRow = null;

  function selectRow(row) {
    selectedRow = row;
    for (const item of rows) {
      const selected = item === row;
      item.classList.toggle("patient-row-selected", selected);
      item.querySelector(".patient-row-radio").checked = selected;
    }
    workflow.disabled = false;
    selectedLabel.textContent = `Selected patient: ${row.dataset.patientName} (${row.dataset.patientId})`;
    acknowledgmentLabel.hidden = row.dataset.needsAck !== "true";
    acknowledgment.checked = false;
    error.hidden = true;
    updateButton();
  }

  function updateButton() {
    button.disabled = !selectedRow || !workflow.value;
  }

  rows.forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("input")) {
        selectRow(row);
        return;
      }
      selectRow(row);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRow(row);
      }
    });
  });
  workflow.addEventListener("change", updateButton);

  button.addEventListener("click", async () => {
    if (!selectedRow || !workflow.value) return;
    error.hidden = true;
    button.disabled = true;
    workflow.disabled = true;
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": document.querySelector("meta[name='csrf-token']").content,
        },
        body: JSON.stringify({
          patient_id: selectedRow.dataset.patientId,
          workflow: workflow.value,
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
      workflow.disabled = false;
      updateButton();
    }
  });
})();
