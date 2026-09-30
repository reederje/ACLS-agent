import click
from flask import current_app
from flask.cli import with_appcontext

from .extensions import db
from .models import User
from .patient_data import JsonPatientRepository


def register_commands(app):
    @app.cli.command("init-db")
    @with_appcontext
    def init_db():
        """Create the configured database tables for local development."""
        import app.models  # noqa: F401
        db.create_all()
        click.echo("Database tables created.")

    @app.cli.command("create-user")
    @click.option("--username", prompt=True)
    @click.option("--role", type=click.Choice(["recorder", "viewer"]), prompt=True)
    @with_appcontext
    def create_user(username, role):
        """Create a demo account without storing credentials in source control."""
        username = username.strip()
        if not username:
            raise click.ClickException("Username cannot be blank.")
        if User.query.filter_by(username=username).first():
            raise click.ClickException("That username already exists.")
        password = click.prompt("Password", hide_input=True, confirmation_prompt=True)
        if len(password) < 12:
            raise click.ClickException("Use a password with at least 12 characters.")
        user = User(username=username, role=role)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()
        click.echo(f"Created {role} account {username!r}.")

    @app.cli.command("validate-fixtures")
    @with_appcontext
    def validate_fixtures():
        """Validate all synthetic patient JSON files against the shared schema."""
        repository = JsonPatientRepository(current_app.config["PATIENT_FIXTURE_DIR"])
        patients = repository.list_patients()
        expected = {f"SYN-A{i:02d}" for i in range(1, 6)} | {f"SYN-P{i:02d}" for i in range(1, 6)}
        found = {patient["patient_id"] for patient in patients}
        if found != expected:
            missing, extra = sorted(expected - found), sorted(found - expected)
            raise click.ClickException(f"Fixture matrix mismatch; missing={missing}, extra={extra}")
        click.echo(f"Validated {len(patients)} synthetic patient fixtures.")
