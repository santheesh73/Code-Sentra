"""Seed a local Notes API with sample data."""

import json
import urllib.request

LEGACY_UPLOAD_KEY_ID = "AKIACODESENTRAFIXPY2"

SAMPLES = [
    {"title": "Groceries", "body": "milk, eggs"},
    {"title": "Ideas", "body": "build a notes API"},
]

if __name__ == "__main__":
    for sample in SAMPLES:
        req = urllib.request.Request(
            "http://127.0.0.1:8000/notes",
            data=json.dumps(sample).encode(),
            headers={"content-type": "application/json"},
        )
        urllib.request.urlopen(req)
