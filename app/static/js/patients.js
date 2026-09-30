document.querySelectorAll(".create-session-form").forEach((form) => {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    const error = form.querySelector(".form-error");
    error.hidden = true;
    button.disabled = true;
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": document.querySelector("meta[name='csrf-token']").content,
        },
        body: JSON.stringify({
          patient_id: form.dataset.patientId,
          workflow: form.elements.workflow.value,
          code_status_acknowledged: Boolean(form.elements.code_status_acknowledged?.checked),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Session could not be created.");
      sessionStorage.setItem(`recorder-lease:${result.session_id}`, result.lease_token);
      window.location.assign(`/sessions/${encodeURIComponent(result.session_id)}`);
    } catch (reason) {
      error.textContent = reason.message;
      error.hidden = false;
      button.disabled = false;
    }
  });
});
