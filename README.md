# garmin-pulse-api

Backend for the "live pulse" widget on nikmargetic.com. It reads your heart
rate from Garmin Connect and publishes it as a small JSON file the Framer
widget can fetch.

## How it works

Garmin doesn't offer a public API for personal projects, so this uses
[python-garminconnect](https://github.com/cyberjunky/python-garminconnect),
a library that logs into Garmin Connect the same way the Garmin Connect app
does. Your watch syncs to Garmin's servers via your phone every few hours —
not instantly — so this isn't a true real-time feed. It's "last known heart
rate, honestly labeled with how long ago it synced."

Every 15 minutes, a free GitHub Action:
1. Logs in to Garmin using a saved session (not your password — see below)
2. Fetches your current heart rate, resting heart rate, and last 24h of readings
3. Writes the result to `public/pulse.json`
4. Commits it, which Vercel picks up and redeploys automatically

The widget just does a plain `fetch()` of that JSON file.

(Vercel's own free-tier cron jobs only run once a day, which is too
infrequent for this — that's why the fetching happens in GitHub Actions
instead, and Vercel is just serving the resulting static file.)

## One-time setup (you need to do this part)

Your Garmin password is never typed by Claude and never stored in this repo.
Here's what you need to do:

1. **Fill in your login.** Open `.env.local` in this folder and put your
   Garmin Connect email and password in it:
   ```
   GARMIN_EMAIL=you@example.com
   GARMIN_PASSWORD=your-password
   ```

2. **Install dependencies** (one time):
   ```bash
   python3 -m pip install -r scripts/requirements.txt
   ```

3. **Run the login script:**
   ```bash
   python3 scripts/setup_garmin_auth.py
   ```
   If your Garmin account has two-factor authentication (2FA) turned on,
   Garmin will text or email you a code, and this script will pause and ask
   you to type it in. That's expected — type the code and hit enter.

   On success, this saves a session file to `.garmin_tokens/` (it's
   gitignored, so it never gets committed).

4. **Store the session as a GitHub secret.** This pipes it straight into
   GitHub without ever displaying it:
   ```bash
   python3 scripts/print_tokens_for_github.py --raw | gh secret set GARMIN_TOKENS
   ```
   The `--raw` flag matters: without it the script also prints explanatory
   text, which would end up inside the secret and break the login.

   If you'd rather do it by hand, run it without `--raw`, copy the long
   line it prints, and paste that at the repo's Settings → Secrets and
   variables → Actions → New repository secret, named `GARMIN_TOKENS`.

That's it — after that, the GitHub Action runs on its own every 15 minutes
and keeps `public/pulse.json` fresh, without ever needing your password again.

**If it ever stops working** (e.g. after many months, if Garmin invalidates
the session): just repeat steps 3–5 to re-authenticate and update the secret.

## Testing locally

After step 3 above, you can run the fetch manually to see real data:
```bash
python3 scripts/fetch_garmin.py
cat public/pulse.json
```

## pulse.json shape

```json
{
  "bpm": 62,
  "restingHeartRate": 54,
  "min24h": 51,
  "max24h": 118,
  "series24h": [[1692864000000, 62], ...],
  "lastSyncedAt": "2026-08-24T14:32:00+00:00",
  "fetchedAt": "2026-08-24T15:00:03+00:00"
}
```
`series24h` is a list of `[timestamp_ms, bpm]` pairs, oldest first — this
feeds the scrolling ECG trace. `lastSyncedAt` is when your watch actually
last recorded a heart rate reading (not when this file was generated) —
that's what the widget should show as "last synced X min ago".

## Deploying

```bash
npx vercel
```
Follow the prompts, accept the defaults (it's a static site, no build step).
Once deployed, `https://<your-project>.vercel.app/pulse.json` is the URL the
Framer widget fetches.

## Layout

```
public/pulse.json   <- the only file Vercel serves
vercel.json         <- static config + CORS headers
scripts/            <- fetcher + auth helpers; run by GitHub Actions, never by Vercel
.github/workflows/  <- the 15-minute cron
```

The Python lives in `scripts/` rather than the repo root on purpose: with
`requirements.txt` at the root, Vercel auto-detects the project as a Python
app and fails the build looking for a web server entrypoint. This is a static
site, so the root is kept free of Python markers.
