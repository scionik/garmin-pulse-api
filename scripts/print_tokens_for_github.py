"""
Packs .garmin_tokens/ into one base64 line to paste into a GitHub secret.

Run after setup_garmin_auth.py has created .garmin_tokens/:

    python3 print_tokens_for_github.py

Then in the repo on GitHub: Settings -> Secrets and variables -> Actions ->
New repository secret, name it GARMIN_TOKENS, and paste the printed value.

Or, to set it in one step without the value ever being displayed:

    python3 print_tokens_for_github.py --raw | gh secret set GARMIN_TOKENS

--raw prints the token and nothing else, which is what makes it safe to pipe.
"""

import base64
import io
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKENS_DIR = ROOT / ".garmin_tokens"


def main():
    if not TOKENS_DIR.exists() or not any(TOKENS_DIR.iterdir()):
        print("No .garmin_tokens/ found. Run setup_garmin_auth.py first.")
        sys.exit(1)

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        tar.add(TOKENS_DIR, arcname=".garmin_tokens")
    encoded = base64.b64encode(buf.getvalue()).decode()

    # --raw: emit only the token, so it can be piped straight into `gh secret set`.
    # Without this the surrounding instructions get swallowed into the secret too.
    if "--raw" in sys.argv:
        print(encoded)
        return

    print("\nGARMIN_TOKENS secret value (copy the whole line below):\n")
    print(encoded)
    print(
        "\nAdd it at: github.com/<repo>/settings/secrets/actions "
        "-> New repository secret -> name it GARMIN_TOKENS"
    )


if __name__ == "__main__":
    main()
