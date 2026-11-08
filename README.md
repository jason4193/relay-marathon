# December Relay Marathon

Availability page for the December Relay Marathon on the Village Green track, UNSW Kensington. 94 laps (42.195 km), shared between runners.

People add every morning (from 8:00) and evening (from 17:00) they're free between Sun 29 Nov and Sun 13 Dec, plus an optional laps guess. The page shows who's free when, so the organisers can pick the day.

- Static site on GitHub Pages. No build step, no framework.
- Entries are stored in a Google Sheet through a Google Apps Script web app.
- Anyone with the link can add their times. No sign-in.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page. Inline CSS and JS. |
| `config.js` | `API_URL`. |
| `apps-script/Code.gs` | Copy of the deployed backend. The header comment has the API contract. |

## Change the date window

The window lives only in `apps-script/Code.gs` (`FIRST_DAY`, `LAST_DAY`). The page reads it from the API, so change it there and redeploy the script (see below). `index.html` has the same two dates as a fallback that shows for a second while the page loads.

## Moderate

Moderation happens in the Google Sheet (tab `Availability`), not on the page. The old `RSVPs` tab is from the first version and is no longer read.

- **Mark the host:** type `TRUE` in the `host` cell of Ken's row. The page then shows a Host badge on his row and fades the times he hasn't picked, in both the board and the calendar picker. Times he can't make are left out of "Best so far".
- **Remove an entry (reversible):** set its `hidden` cell to `TRUE`. It drops off the page within 30 seconds. Set it back to `FALSE` to restore it.
- **Remove an entry for good:** right-click the row number > Delete row.
- **Fix a name, times or laps:** edit the cell. `slots` is a comma-separated list such as `2026-12-05-am, 2026-12-06-pm`. Leave `laps` blank for "not sure".
- **Add someone by hand:** type a new row with `name`, `slots` and optionally `laps`. Leave `id` and `tokenHash` empty. Nobody can edit that row from the page; change it in the Sheet.
- People can edit or remove only the entries they created, from the same browser. The page keeps their edit tokens in `localStorage` (`relay2026.avail`). If they clear browser data or switch device, they need to ask the organiser.

Limits in `Code.gs`: 300 rows in total (hidden rows count), and 60 writes per 10 minutes across everyone.

## Redeploy the script

After any change to `Code.gs`:

1. Open the Apps Script project, paste the new code, save.
2. Deploy > Manage deployments > edit (pencil) on the existing deployment.
3. Version: **New version**. Keep "Execute as: Me" and "Who has access: Anyone".
4. Deploy.

Editing the existing deployment keeps the same `/exec` URL, so `config.js` doesn't change. "New deployment" creates a new URL. Avoid it unless you also update `API_URL`.

## How the page talks to the API

- Read: `GET API_URL` on load, every 30 s while the tab is visible, and after each save.
- Write: `POST API_URL` with a JSON body sent as `text/plain`, so the browser skips the CORS preflight (Apps Script can't answer one). Actions are `create`, `update` and `delete`.
- A hidden `website` field is a honeypot. Bots fill it and the server ignores them.
