"""
Run this ONCE, yourself, on your own machine:

    python3 setup_garmin_auth.py

It logs into Garmin Connect with the email/password you put in .env.local.
If your account has 2FA turned on, it will ask you to type in the code
Garmin sends you. On success it saves a session to .garmin_tokens/.

That saved session -- not your password -- is what fetch_garmin.py and the
scheduled GitHub Action use afterwards. Your credentials are only ever read
here, on your machine, never sent anywhere else and never stored in the repo.

After this succeeds, run:

    python3 print_tokens_for_github.py

and paste the single line it prints as a GitHub Actions secret named
GARMIN_TOKENS on this repo. That's the only manual step needed to keep the
widget's data refreshing on a schedule.
"""

import os
import sys
from getpass import getpass

from dotenv import load_dotenv
from garminconnect import Garmin

load_dotenv(".env.local")

TOKENS_DIR = os.path.join(os.path.dirname(__file__), ".garmin_tokens")


def main():
    email = os.environ.get("GARMIN_EMAIL", "").strip()
    password = os.environ.get("GARMIN_PASSWORD", "").strip()

    if not email or not password:
        print(
            "GARMIN_EMAIL and/or GARMIN_PASSWORD are empty in .env.local.\n"
            "Open that file and fill in your Garmin Connect login, then run this again."
        )
        sys.exit(1)

    print(f"Logging in as {email} ...")
    garmin = Garmin(
        email=email,
        password=password,
        prompt_mfa=lambda: getpass("Garmin sent you a 2FA code -- enter it here: ").strip(),
    )
    garmin.login(TOKENS_DIR)

    print(f"\nDone. Session saved to {TOKENS_DIR}/")
    print("Next: python3 print_tokens_for_github.py")


if __name__ == "__main__":
    main()
