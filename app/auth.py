from functools import wraps

from flask import Blueprint, abort, flash, redirect, render_template, request, session, url_for

from .extensions import db, limiter
from .models import User

auth = Blueprint("auth", __name__)


def current_user() -> User | None:
    user_id = session.get("user_id")
    if user_id is None:
        return None
    user = db.session.get(User, user_id)
    return user if user and user.active else None


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if current_user() is None:
            return redirect(url_for("auth.login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def role_required(*roles):
    def decorate(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            user = current_user()
            if user is None:
                abort(401)
            if user.role not in roles:
                abort(403)
            return view(*args, **kwargs)
        return wrapped
    return decorate


@auth.route("/login", methods=["GET", "POST"])
@limiter.limit("5 per minute", methods=["POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = User.query.filter_by(username=username, active=True).first()
        if user is None or not user.check_password(password):
            flash("Login failed. Check your credentials and try again.", "error")
            return render_template("login.html"), 401
        session.clear()
        session["user_id"] = user.id
        session["role"] = user.role
        endpoint = "patients.list_patients" if user.role == "recorder" else "patients.viewer_home"
        return redirect(url_for(endpoint))
    return render_template("login.html")


@auth.post("/logout")
@login_required
def logout():
    session.clear()
    return redirect(url_for("auth.login"))
