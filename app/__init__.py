import os
from pathlib import Path

from flask import Flask, jsonify, render_template, request
from flask_wtf.csrf import CSRFError
from werkzeug.exceptions import HTTPException

from .config import Config
from .extensions import csrf, db, limiter, migrate


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_object(Config)
    if test_config:
        app.config.update(test_config)

    if app.config.get("APP_ENV", os.getenv("APP_ENV", "development")) == "production":
        if app.config["SECRET_KEY"] == "local-development-only-change-before-deploy":
            raise RuntimeError("SECRET_KEY must be configured for production")
        app.config["SESSION_COOKIE_SECURE"] = True

    Path(app.instance_path).mkdir(parents=True, exist_ok=True)
    db.init_app(app)
    migrate.init_app(app, db)
    csrf.init_app(app)
    limiter.init_app(app)

    from . import models  # noqa: F401
    from .auth import auth
    from .patients import patients
    from .sessions import sessions
    from .cli import register_commands

    app.register_blueprint(auth)
    app.register_blueprint(patients)
    app.register_blueprint(sessions)
    register_commands(app)

    @app.get("/healthz")
    def healthz():
        return jsonify(status="ok", mode="synthetic-prototype")

    @app.errorhandler(CSRFError)
    def handle_csrf_error(error):
        if request.path.startswith("/api/"):
            return jsonify(error="CSRF validation failed. Refresh and retry."), 400
        return "CSRF validation failed. Refresh the page and try again.", 400

    @app.errorhandler(HTTPException)
    def handle_http_error(error):
        if request.path.startswith("/api/"):
            return jsonify(error=error.description), error.code
        return error

    @app.get("/")
    def index():
        from flask import session as browser_session

        if browser_session.get("user_id"):
            return render_template("home.html")
        return render_template("login.html")

    return app
