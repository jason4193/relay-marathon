/**
 * December Relay Marathon — RSVP backend (Google Apps Script web app)
 *
 * Bound to the Google Sheet that stores the RSVPs.
 *   GET  <exec URL>                -> { ok, rsvps:[{id,name,date,laps,createdAt}], totalLaps, dates, serverTime }
 *   POST <exec URL>  (text/plain body, JSON)
 *        { action:"create", name, date, laps, website:"" }          -> { ok, id, editToken, rsvp }
 *        { action:"update", id, editToken, name, date, laps }       -> { ok, rsvp }
 *        { action:"delete", id, editToken }                         -> { ok }
 *   Errors: { ok:false, error:"<code>", message:"<human text>" }
 *     codes: bad_request, invalid_name, invalid_date, invalid_laps, duplicate_name,
 *            not_found, forbidden, full, rate_limited, busy, unknown_action
 *
 * The organiser moderates in the Sheet itself:
 *   - set column "hidden" to TRUE to hide a row, or delete the row
 *   - add a runner by typing a new row (name, date, laps); id/token can stay empty
 */

// ---- config (keep DATES in sync with the web page) -------------------------
const SHEET_NAME = 'RSVPs';
const HEADERS = ['id', 'name', 'date', 'laps', 'createdAt', 'updatedAt', 'tokenHash', 'hidden'];
const DATES = ['2026-12-05', '2026-12-06', '2026-12-12', '2026-12-13', 'any'];
const TOTAL_LAPS = 94;
const MAX_LAPS_PER_PERSON = 94;
const MAX_NAME_LENGTH = 40;
const MAX_ROWS = 300;                 // hard cap on entries
const MAX_WRITES_PER_10_MIN = 60;     // global write budget (spam brake)
const TZ = 'Australia/Sydney';

// ---- run once from the editor to create the sheet and authorise ------------
function setup() {
  const sh = getSheet_();
  sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).setNumberFormat('@'); // plain text, so dates aren't auto-converted
  sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  Logger.log('Sheet "%s" ready with %s rows.', SHEET_NAME, sh.getLastRow() - 1);
}

// ---- HTTP handlers ---------------------------------------------------------
function doGet() {
  const rows = readAll_(getSheet_());
  const list = rows
    .filter(r => !r.hidden && r.name && r.laps > 0)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map(publicView_);
  return json_({ ok: true, rsvps: list, totalLaps: TOTAL_LAPS, dates: DATES, serverTime: new Date().toISOString() });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return fail_('bad_request', 'The request could not be read.');
  }
  if (!body || typeof body !== 'object') return fail_('bad_request', 'The request could not be read.');
  if (body.website) return json_({ ok: true, ignored: true }); // honeypot: bots fill hidden fields

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return fail_('busy', 'Lots of sign-ups right now. Try again in a moment.');
  try {
    if (!rateOk_()) return fail_('rate_limited', 'Too many changes in the last few minutes. Try again shortly.');
    const sh = getSheet_();
    const rows = readAll_(sh);
    switch (body.action) {
      case 'create': return create_(sh, rows, body);
      case 'update': return update_(sh, rows, body);
      case 'delete': return delete_(sh, rows, body);
      default: return fail_('unknown_action', 'Unknown action.');
    }
  } finally {
    lock.releaseLock();
  }
}

// ---- actions ---------------------------------------------------------------
function create_(sh, rows, body) {
  const v = validate_(body);
  if (v.error) return fail_(v.error, v.message);
  if (rows.length >= MAX_ROWS) return fail_('full', 'The RSVP list is full. Contact the organiser.');
  if (nameTaken_(rows, v.name, null)) {
    return fail_('duplicate_name', 'That name is already on the list. Add a surname initial, or edit your existing RSVP.');
  }
  const id = Utilities.getUuid();
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const now = new Date().toISOString();
  sh.appendRow([id, v.name, v.date, String(v.laps), now, now, sha256_(token), 'FALSE']);
  return json_({ ok: true, id: id, editToken: token, rsvp: { id: id, name: v.name, date: v.date, laps: v.laps, createdAt: now } });
}

function update_(sh, rows, body) {
  const r = authorise_(rows, body);
  if (r.error) return fail_(r.error, r.message);
  const v = validate_(body);
  if (v.error) return fail_(v.error, v.message);
  if (nameTaken_(rows, v.name, r.row.id)) {
    return fail_('duplicate_name', 'That name is already on the list. Add a surname initial.');
  }
  const now = new Date().toISOString();
  sh.getRange(r.row.rowIndex, 2, 1, 5).setValues([[v.name, v.date, String(v.laps), r.row.createdAt, now]]);
  return json_({ ok: true, rsvp: { id: r.row.id, name: v.name, date: v.date, laps: v.laps, createdAt: r.row.createdAt } });
}

function delete_(sh, rows, body) {
  const r = authorise_(rows, body);
  if (r.error) return fail_(r.error, r.message);
  sh.deleteRow(r.row.rowIndex);
  return json_({ ok: true });
}

// ---- helpers ---------------------------------------------------------------
function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  return sh;
}

function readAll_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  return values.map((c, i) => {
    const rowIndex = i + 2;
    return {
      rowIndex: rowIndex,
      id: String(c[0] || '').trim() || ('row-' + rowIndex), // rows typed by hand get a stable-enough id
      name: cleanName_(c[1]),
      date: normDate_(c[2]),
      laps: clampInt_(c[3], 0, 500),
      createdAt: c[4] instanceof Date ? c[4].toISOString() : String(c[4] || ''),
      tokenHash: String(c[6] || ''),
      hidden: c[7] === true || String(c[7]).trim().toUpperCase() === 'TRUE'
    };
  });
}

function publicView_(r) {
  return { id: r.id, name: r.name, date: r.date, laps: r.laps, createdAt: r.createdAt };
}

function validate_(body) {
  const name = cleanName_(body.name);
  if (!name) return { error: 'invalid_name', message: 'Add a name so others know who is running.' };
  const date = String(body.date || '');
  if (DATES.indexOf(date) === -1) return { error: 'invalid_date', message: 'Pick one of the listed dates.' };
  const laps = Math.round(Number(body.laps));
  if (!(laps >= 1 && laps <= MAX_LAPS_PER_PERSON)) {
    return { error: 'invalid_laps', message: 'Enter between 1 and ' + MAX_LAPS_PER_PERSON + ' laps.' };
  }
  return { name: name, date: date, laps: laps };
}

function authorise_(rows, body) {
  const id = String(body.id || '');
  const token = String(body.editToken || '');
  const row = rows.find(r => r.id === id);
  if (!row) return { error: 'not_found', message: 'That RSVP is no longer on the list.' };
  if (!token || !row.tokenHash || sha256_(token) !== row.tokenHash) {
    return { error: 'forbidden', message: 'This RSVP can only be changed from the device that created it. Ask the organiser.' };
  }
  return { row: row };
}

function nameTaken_(rows, name, exceptId) {
  const key = name.toLowerCase();
  return rows.some(r => !r.hidden && r.id !== exceptId && r.name.toLowerCase() === key);
}

function cleanName_(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[=+\-@\s]+/, '')   // never let a name start like a spreadsheet formula
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

function normDate_(v) {
  let s;
  if (v instanceof Date) s = Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  else s = String(v || '').trim();
  return DATES.indexOf(s) !== -1 ? s : 'any';
}

function clampInt_(v, min, max) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return 0;
  return Math.min(Math.max(n, min), max);
}

function rateOk_() {
  const cache = CacheService.getScriptCache();
  const key = 'writes-' + Math.floor(Date.now() / 600000);
  const n = Number(cache.get(key) || 0);
  if (n >= MAX_WRITES_PER_10_MIN) return false;
  cache.put(key, String(n + 1), 700);
  return true;
}

function sha256_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  return json_({ ok: false, error: code, message: message });
}
