from flask import Blueprint, current_app, render_template

from .auth import current_user, login_required, role_required
from .patient_data import JsonPatientRepository

patients = Blueprint("patients", __name__)


def repository() -> JsonPatientRepository:
    return JsonPatientRepository(current_app.config["PATIENT_FIXTURE_DIR"])


@patients.get("/patients")
@login_required
@role_required("recorder")
def list_patients():
    return render_template("patients.html", patients=repository().list_patients())


@patients.get("/viewer")
@login_required
@role_required("viewer")
def viewer_home():
    return render_template("home.html", user=current_user())
