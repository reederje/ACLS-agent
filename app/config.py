import os


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "local-development-only-change-before-deploy")
    SQLALCHEMY_DATABASE_URI = os.getenv(
        "DATABASE_URL", "sqlite:///resuscitation-local.sqlite3"
    ).replace("postgres://", "postgresql://", 1)
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True}
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true"
    WTF_CSRF_TIME_LIMIT = 3600
    DISPLAY_TIMEZONE = os.getenv("DISPLAY_TIMEZONE", "UTC")
    AI_PROVIDER = os.getenv("AI_PROVIDER", "mock").lower()
    AI_TIMEOUT_SECONDS = float(os.getenv("AI_TIMEOUT_SECONDS", "15"))
    AZURE_OPENAI_BASE_URL = os.getenv("AZURE_OPENAI_BASE_URL", "")
    AZURE_OPENAI_DEPLOYMENT = os.getenv("AZURE_OPENAI_DEPLOYMENT", "")
    AZURE_OPENAI_API_KEY = os.getenv("AZURE_OPENAI_API_KEY", "")
    PATIENT_FIXTURE_DIR = os.getenv("PATIENT_FIXTURE_DIR", "app/fixtures/patients")
    PROTOCOL_RULESET_VERSION = os.getenv("PROTOCOL_RULESET_VERSION", "2025.0-unverified")
