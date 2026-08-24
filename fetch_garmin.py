"""
Fetches heart-rate data from Garmin Connect and writes public/pulse.json.

Run manually:      python3 fetch_garmin.py
Run on a schedule:  .github/workflows/fetch-garmin.yml calls this every ~15 min.

Auth: this script never asks for a password. It only reads a saved session
from .garmin_tokens/ (created once by setup_garmin_auth.py). In GitHub
Actions, that same session is restored from the GARMIN_TOKENS secret.
If no valid session is found, it prints instructions and exits --
it does NOT fall back to prompting for credentials, so it's safe to run
unattended.
"""

import base64
import io
import json
import os
import sys
import tarfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
)

load_dotenv(".env.local")

HERE = Path(__file__).parent
TOKENS_DIR = HERE / ".garmin_tokens"
OUTPUT_PATH = HERE / "public" / "pulse.json"


def restore_tokens_from_env():
    """In CI, GARMIN_TOKENS holds the .garmin_tokens/ folder as base64 tar.gz."""
    blob = os.environ.get("GARMIN_TOKENS", "").strip()
    if not blob:
        return
    TOKENS_DIR.mkdir(exist_ok=True)
    raw = base64.b64decode(blob)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        tar.extractall(TOKENS_DIR)


def get_client() -> Garmin:
    restore_tokens_from_env()
    if not TOKENS_DIR.exists() or not any(TOKENS_DIR.iterdir()):
        print(
            "No saved Garmin session in .garmin_tokens/ and no GARMIN_TOKENS env var.\n"
            "Run setup_garmin_auth.py once locally first, then "
            "print_tokens_for_github.py to get the GitHub secret value."
        )
        sys.exit(1)

    garmin = Garmin()
    try:
        garmin.login(str(TOKENS_DIR))
    except (GarminConnectAuthenticationError, GarminConnectConnectionError) as e:
        print(
            f"Saved Garmin session is no longer valid ({e}).\n"
            "Run setup_garmin_auth.py again to re-authenticate, then update the "
            "GARMIN_TOKENS GitHub secret via print_tokens_for_github.py."
        )
        sys.exit(1)
    return garmin


def merge_heart_rate_series(days_data: list[dict]) -> list[list]:
    """Combine heartRateValues from one or more get_heart_rates() days."""
    samples = []
    for day in days_data:
        for point in day.get("heartRateValues") or []:
            ts_ms, bpm = point
            if bpm is not None:
                samples.append([ts_ms, bpm])
    samples.sort(key=lambda p: p[0])
    return samples


def main():
    garmin = get_client()

    today = datetime.now().date()
    yesterday = today - timedelta(days=1)

    today_data = garmin.get_heart_rates(today.isoformat())
    try:
        yesterday_data = garmin.get_heart_rates(yesterday.isoformat())
    except Exception:
        yesterday_data = {}

    all_samples = merge_heart_rate_series([yesterday_data, today_data])

    if not all_samples:
        print("No heart rate samples returned for today or yesterday.")
        sys.exit(1)

    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    cutoff_ms = now_ms - 24 * 60 * 60 * 1000
    series_24h = [p for p in all_samples if p[0] >= cutoff_ms]
    if not series_24h:
        series_24h = all_samples[-96:]  # fallback: last ~24h at 15min cadence

    last_ts_ms, last_bpm = all_samples[-1]
    bpm_values = [p[1] for p in series_24h]

    output = {
        "bpm": last_bpm,
        "restingHeartRate": today_data.get("restingHeartRate"),
        "min24h": min(bpm_values),
        "max24h": max(bpm_values),
        "series24h": series_24h,
        "lastSyncedAt": datetime.fromtimestamp(
            last_ts_ms / 1000, tz=timezone.utc
        ).isoformat(),
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }

    OUTPUT_PATH.parent.mkdir(exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, indent=2))
    print(f"Wrote {OUTPUT_PATH} -- bpm={last_bpm}, resting={output['restingHeartRate']}")


if __name__ == "__main__":
    main()
