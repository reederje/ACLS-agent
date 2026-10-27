# Resuscitation Application (synthetic prototype)

This repository implements the clinical prototype described in `resuscitation_app_specification.md`. It is restricted to authored synthetic cases and must not be used to guide care for real patients. Deterministic advisory guidance is enabled only for the clinician-approved adult cardiac-arrest flow; all other ACLS/PALS pathways remain disabled. Software tests are not clinical validation.

## Current milestone

The current local prototype includes a Flask application factory, SQLAlchemy persistence, hashed recorder/viewer accounts, CSRF protection, basic login throttling, ten validated synthetic patient fixtures, calendar-month context projection, session creation, explicit lifecycle/workflow actions, idempotent event writes, single-recorder lease/takeover, derived timers, a desktop recording workspace, a read-only status board, and deterministic adult-arrest recommendations based on recorded rhythm/pulse and interventions. Recommendations do not record events or calculate medication doses/routes. AI summaries and other clinical pathways are not enabled.

For timer transitions and event-flow behavior, run `python -m pytest`. `flask --app wsgi.py validate-fixtures` verifies the ten-case fixture matrix.

## Run locally

Requirements: Python 3.11 or newer (the project is also tested with Python 3.14) and a terminal opened in this repository directory.

### Windows PowerShell

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
```

If PowerShell blocks virtual-environment activation, use Command Prompt instead:

```bat
py -3 -m venv .venv
.venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
copy .env.example .env
```

### macOS / Linux

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env
```

Before running, edit `.env` and replace `SECRET_KEY` with a unique random value. Keep `.env` private and do not commit passwords, API keys, or real patient data. Local settings use SQLite and `AI_PROVIDER=mock`; set `AI_PROVIDER=openai`, `OPENAI_API_KEY`, and optionally `OPENAI_MODEL` (default `gpt-5.5`) in `.env` to enable the AI summary.

### Initialize, create accounts, and start

With the virtual environment activated, run:

```sh
flask --app wsgi.py init-db
flask --app wsgi.py create-user
```

For `create-user`, enter a username, choose `recorder` or `viewer`, then enter and confirm a password of at least 12 characters. Run the command once for each account you need. Password input is hidden; passwords are stored as hashes.

Validate the synthetic fixtures and start the development server:

```sh
flask --app wsgi.py validate-fixtures
flask --app wsgi.py run --host 127.0.0.1 --port 5000
```

Open <http://127.0.0.1:5000/> in a browser and sign in with the account you created. The recorder can select a synthetic case, choose a workflow, and create a session. A viewer account is read-only. Stop the development server with `Ctrl+C`.

The development server is not for production. The adult-arrest guidance is advisory and synthetic-only, and is not validated for live clinical use. AI summaries and other clinical pathways are not enabled.

### Run tests

With the virtual environment activated:

```sh
python -m pytest
```

### Troubleshooting

- If port 5000 is already in use, start on another port, for example `flask --app wsgi.py run --host 127.0.0.1 --port 5001`, then open <http://127.0.0.1:5001/>.
- If sign-in fails, create an account with `flask --app wsgi.py create-user`. The app does not ship with demo credentials.
- If the database is missing, run `flask --app wsgi.py init-db` from the project root.
- If PowerShell script execution is restricted, use the Command Prompt activation commands above; avoid changing machine-wide execution policy just for this project.

## Azure direction

The intended hosting target is Azure App Service on Linux with Gunicorn and PostgreSQL configured using `DATABASE_URL`. Production requires a strong secret, HTTPS, secure cookies, proper database migrations, shared rate-limit storage for multiple workers/instances, and an explicitly configured AI provider if AI is enabled. Deployment is not yet production-ready. SQLite is for local development/testing only and is not claimed safe for App Service scale-out. No paid resources are provisioned by this repository.
