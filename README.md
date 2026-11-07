# December Relay Marathon

RSVP page for the December Relay Marathon on the Village Green track, UNSW Kensington. 94 laps (42.195 km), shared between runners.

- Static site on GitHub Pages. No build step, no framework.
- RSVPs are stored in a Google Sheet through a Google Apps Script web app.
- Anyone with the link can RSVP. No sign-in.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page. Inline CSS and JS. |
| `config.js` | `API_URL` and `CONFIRMED_DATE`. |
| `apps-script/Code.gs` | Copy of the deployed backend, for reference. The header comment has the API contract. |

## Change the config

Edit `config.js`, commit and push to `main`. Pages redeploys in about a minute.

- `API_URL`: the Apps Script web app URL (ends in `/exec`).
- `CONFIRMED_DATE`: `null` while the date is open. Set it to one of `"2026-12-05"`, `"2026-12-06"`, `"2026-12-12"`, `"2026-12-13"` once the date is fixed. The hero then shows that date as confirmed, and the form hides the date picker and sends that date. The per-date tally stays as it is.

### The date list lives in two places

The dates are in `index.html` (`DATES` in the script) and in `apps-script/Code.gs` (`DATES`). Change both together, then redeploy the script (see below). If they differ, the server rejects the new date, or the page shows it as "Any date".

## Moderate

Moderation happens in the Google Sheet (tab `RSVPs`), not on the page. The page has no admin controls, because everyone with the link sees the same page.

- **Remove an RSVP (reversible):** set its `hidden` cell to `TRUE`. It drops off the page within 30 seconds (the next poll). Set it back to `FALSE` to restore it. A hidden name can be used again by someone else.
- **Remove an RSVP for good:** right-click the row number > Delete row.
- **Fix a name, date or laps:** edit the cell. Dates must be one of the ids in `DATES` (for example `2026-12-12`) or `any`.
- **Add a runner by hand:** type a new row with `name`, `date` and `laps`. Leave `id` and `tokenHash` empty. Nobody can edit that row from the page; change it in the Sheet.
- Runners can edit or remove only the entries they created, from the same browser. The page keeps their edit tokens in `localStorage` (`relay2026.mine`). If they clear browser data or switch device, they need to ask the organiser.

Limits in `Code.gs`: 300 rows in total (hidden rows count), and 60 writes per 10 minutes across everyone.

## Redeploy the script

After any change to `Code.gs`:

1. Open the Apps Script project, paste the new code, save.
2. Deploy > Manage deployments > edit (pencil) on the existing deployment.
3. Version: **New version**. Keep "Execute as: Me" and "Who has access: Anyone".
4. Deploy.

Editing the existing deployment keeps the same `/exec` URL, so `config.js` doesn't change. "New deployment" creates a new URL. Avoid it unless you also update `API_URL`.

Then copy the new `Code.gs` into `apps-script/` here and commit it.

## How the page talks to the API

- Read: `GET API_URL` on load, every 30 s while the tab is visible, and after each save.
- Write: `POST API_URL` with a JSON body sent as `text/plain`, so the browser skips the CORS preflight (Apps Script can't answer one). Actions are `create`, `update` and `delete`.
- A hidden `website` field is a honeypot. Bots fill it and the server ignores them.
