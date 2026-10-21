import os

DB_PATH = os.environ.get("NOTES_DB_PATH", ":memory:")
SIGNING_KEY = os.getenv("NOTES_SIGNING_KEY")
