/**
 * December Relay Marathon — availability backend (Google Apps Script web app)
 *
 * Bound to the Google Sheet. Entries live in the "Availability" tab.
 * The "RSVPs" tab from the first version is left as it is and no longer read.
 *
 *   GET  <exec URL>  -> { ok, entries:[{id,name,slots,laps,host,createdAt}], totalLaps,
 *                         firstDay, lastDay, slots, serverTime }
 *   POST <exec URL>  (text/plain body, JSON)
 *        { action:"create", name, slots:[...], laps, website:"" }  -> { ok, id, editToken, entry }
 *        { action:"update", id, editToken, name, slots, laps }    -> { ok, entry }
 *        { action:"delete", id, editToken }                       -> { ok }
 *   A slot id is "<yyyy-mm-dd>-am" (morning, from 8:00) or "<yyyy-mm-dd>-pm" (evening, from 17:00).
 *   laps is optional: 0 or missing means "not sure".
 *   Errors: { ok:false, error:"<code>", message:"<human text>" }
 *     codes: bad_request, invalid_name, invalid_slots, invalid_laps, duplicate_name,
 *            not_found, forbidden, full, rate_limited, busy, unknown_action
 *
 * The organiser moderates in the Sheet itself (tab "Availability"):
 *   - set "hidden" to TRUE to hide a row, or delete the row
 *   - set "host" to TRUE on the host's row; the page badges it and fades the times the host can't make
 *   - add a person by typing a row: name, slots (e.g. "2026-12-05-am, 2026-12-06-pm"), laps (optional)
 */

// ---- config (the page reads the window from GET, so this is the only place to change it) ----
const SHEET_NAME = 'Availability';
const HEADERS = ['id', 'name', 'slots', 'laps', 'createdAt', 'updatedAt', 'tokenHash', 'hidden', 'host'];
const FIRST_DAY = '2026-11-29';
const LAST_DAY = '2026-12-13';
const TIMES = ['am', 'pm'];
const SLOTS = buildSlots_(FIRST_DAY, LAST_DAY);
const TOTAL_LAPS = 94;
const MAX_LAPS_PER_PERSON = 94;
const MAX_NAME_LENGTH = 40;
const MAX_ROWS = 300;                 // hard cap on entries
const MAX_WRITES_PER_10_MIN = 60;     // global write budget (spam brake)

// ---- run once from the editor to create the tab ----------------------------
function setup() {
  const sh = getSheet_();
  sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).setNumberFormat('@'); // plain text, so nothing is auto-converted
  sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  Logger.log('Tab "%s" ready with %s rows. %s slots from %s to %s.',
    SHEET_NAME, sh.getLastRow() - 1, SLOTS.length, FIRST_DAY, LAST_DAY);
}

// ---- HTTP handlers ---------------------------------------------------------
function doGet() {
  const rows = readAll_(getSheet_());
  const list = rows
    .filter(r => !r.hidden && r.name && r.slots.length > 0)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map(publicView_);
  return json_({
    ok: true, entries: list, totalLaps: TOTAL_LAPS,
    firstDay: FIRST_DAY, lastDay: LAST_DAY, slots: SLOTS,
    serverTime: new Date().toISOString()
  });
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
  if (!lock.tryLock(10000)) return fail_('busy', 'Lots of people saving right now. Try again in a moment.');
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
  if (rows.length >= MAX_ROWS) return fail_('full', 'The list is full. Contact the organiser.');
  if (nameTaken_(rows, v.name, null)) {
    return fail_('duplicate_name', 'That name is already on the list. Add a surname initial, or edit your existing entry.');
  }
  const id = Utilities.getUuid();
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const now = new Date().toISOString();
  sh.appendRow([id, v.name, v.slots.join(', '), v.laps ? String(v.laps) : '', now, now, sha256_(token), 'FALSE', 'FALSE']);
  return json_({ ok: true, id: id, editToken: token,
    entry: { id: id, name: v.name, slots: v.slots, laps: v.laps, host: false, createdAt: now } });
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
  // columns 2..6: name, slots, laps, createdAt, updatedAt (hidden and host stay as the organiser set them)
  sh.getRange(r.row.rowIndex, 2, 1, 5).setValues([[v.name, v.slots.join(', '), v.laps ? String(v.laps) : '', r.row.createdAt, now]]);
  return json_({ ok: true,
    entry: { id: r.row.id, name: v.name, slots: v.slots, laps: v.laps, host: r.row.host, createdAt: r.row.createdAt } });
}

function delete_(sh, rows, body) {
  const r = authorise_(rows, body);
  if (r.error) return fail_(r.error, r.message);
  sh.deleteRow(r.row.rowIndex);
  return json_({ ok: true });
}

// ---- helpers ---------------------------------------------------------------
function buildSlots_(first, last) {
  const out = [];
  const d = new Date(first + 'T00:00:00Z');
  const end = new Date(last + 'T00:00:00Z');
  while (d <= end) {
    const day = d.toISOString().slice(0, 10);
    TIMES.forEach(t => out.push(day + '-' + t));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

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
      slots: cleanSlots_(String(c[2] || '').split(/[\s,;]+/)),
      laps: clampInt_(c[3], 0, 500),
      createdAt: c[4] instanceof Date ? c[4].toISOString() : String(c[4] || ''),
      tokenHash: String(c[6] || ''),
      hidden: isTrue_(c[7]),
      host: isTrue_(c[8])
    };
  });
}

function publicView_(r) {
  return { id: r.id, name: r.name, slots: r.slots, laps: r.laps, host: r.host, createdAt: r.createdAt };
}

function validate_(body) {
  const name = cleanName_(body.name);
  if (!name) return { error: 'invalid_name', message: 'Add a name so others know who is free.' };
  const slots = Array.isArray(body.slots) ? cleanSlots_(body.slots.slice(0, SLOTS.length * 2)) : [];
  if (!slots.length) return { error: 'invalid_slots', message: 'Pick at least one morning or evening you are free.' };
  let laps = 0;
  if (body.laps !== undefined && body.laps !== null && body.laps !== '' && Number(body.laps) !== 0) {
    laps = Math.round(Number(body.laps));
    if (!(laps >= 1 && laps <= MAX_LAPS_PER_PERSON)) {
      return { error: 'invalid_laps', message: 'Leave laps blank, or enter between 1 and ' + MAX_LAPS_PER_PERSON + '.' };
    }
  }
  return { name: name, slots: slots, laps: laps };
}

// Keeps only known slot ids, without repeats, in calendar order.
function cleanSlots_(list) {
  const want = {};
  list.forEach(s => { want[String(s).trim().toLowerCase()] = true; });
  return SLOTS.filter(s => want[s]);
}

function authorise_(rows, body) {
  const id = String(body.id || '');
  const token = String(body.editToken || '');
  const row = rows.find(r => r.id === id);
  if (!row) return { error: 'not_found', message: 'That entry is no longer on the list.' };
  if (!token || !row.tokenHash || sha256_(token) !== row.tokenHash) {
    return { error: 'forbidden', message: 'This entry can only be changed from the device that created it. Ask the organiser.' };
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

function isTrue_(v) {
  return v === true || String(v).trim().toUpperCase() === 'TRUE';
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
