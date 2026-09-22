# Open Pilot Logbook — how it works

A privacy-focused, open source, **local-first EASA pilot logbook**, built as an
installable PWA. This document is the working context for anyone (human or
Claude) picking the project up: what exists, how it is put together, and the
rules that must not be broken. The open work is in `TODO.md`.

User-facing documentation is `README.md`.

---

## 1. The premise

- **Logbook data never leaves the device.** No backend, no accounts, no sync,
  no telemetry, no third-party scripts. The site is static files; everything
  runs in the browser. Nothing may send logbook data over a network — a change
  that breaks this is not merged, whatever else it does.
- **Backups are files the pilot keeps.** JSON for backup/restore, CSV for
  exchange with other apps. iOS can evict site data after weeks of disuse, so
  the app nags about backups ("last backup: X days ago").
- **Fast entry.** A routine flight should take under 15 seconds.
- **EASA format.** FAA is possible later via the registry, not built.

Hosted on GitHub Pages at `https://smoxey.github.io/OpenLog/`, deployed by
`.github/workflows/deploy.yml` on every push to `main` (tests → build →
publish). `vite-plugin-pwa` with `registerType: 'autoUpdate'` means installed
copies pick up new versions on their next online launch.

---

## 2. Tech stack

| Concern | Choice |
|---|---|
| Framework | Svelte 5 (runes) + Vite + TypeScript |
| Local database | Dexie.js (IndexedDB) |
| CSV | PapaParse |
| PWA | vite-plugin-pwa (offline, autoUpdate) |
| Styling | Plain CSS with a token set on `:root`. No UI libraries |
| Tests | Vitest + fake-indexeddb + jsdom + @testing-library/svelte |

`BASE_PATH` in `vite.config.ts` defaults to `/OpenLog/` for Pages.

---

## 3. Code layout

```
src/lib/
  registry/   The field registry — the single source of truth for every column
  domain/     Pure logic: flights, aircraft, totals, currency, conflicts,
              migration, time sums, opening balance, bulkAdjust, bulkNight
  night/      Solar position, great-circle path, the night calculation
  airports/   Bundled aerodrome list (packed, lazily imported), IATA → ICAO
  import/     CSV parsing, sniffing, column mapping, presets, transform, plan
  import/airside/  The Airside adapter (rewrites the file before mapping)
  export/     JSON backup envelope, CSV export, EASA print layout
  storage/    The ONLY code that touches Dexie
  validation/ One validator, run on every write
  time/       Duration, block-time, time-of-day and zone-offset helpers
  ui/         Svelte components
```

Three rules the codebase holds to:

- **The registry is the contract.** New columns are registry entries; the form,
  list, CSV mapping, validation and totals are generated from it. Components
  never name fields or hardcode per-field logic.
- **Storage is isolated.** Only `lib/storage` knows Dexie exists. Domain code is
  pure and takes inputs as arguments, which is what makes night, conflicts and
  the bulk tools testable without a browser.
- **Derived values are derived once, then stored.** A logbook is a historical
  record; nothing is recomputed on read.

---

## 4. Data model (schema v3)

One `Flight` record per entry, with `id`, `schemaVersion`, `entryType`
(`'flight' | 'fstd'`), date, aerodromes, block times, aircraft type and
registration, `picName`, the EASA time columns (total, PIC, multi-pilot,
single-pilot SE/ME, co-pilot, dual, instructor, night, IFR), day/night
landings, `simulatorMinutes`, `simulatorRegistration`, remarks and `extra`.

A separate aircraft table maps `registration → { type, class: SE|ME, multiPilot }`
(key trimmed and uppercased). Simulator devices never enter it.

Invariants, each tested:

- SE and ME minutes are never both non-zero.
- `flight` → `simulatorMinutes === 0`, `simulatorRegistration === ""`.
- `fstd` → `totalMinutes === 0`, both aerodromes `"SIM"`, `registration === ""`.

Extensibility, preserve all three:

1. **`extra`** on every record carries unknown/future columns untouched. Only
   JSON guarantees it survives.
2. **`schemaVersion` + `migrateFlight`** — v1 → v2 → v3, idempotent, run on
   every read and import. Dexie's `db.version`, record `schemaVersion` and the
   JSON envelope's `formatVersion` are three independent numbers.
3. **The field registry**, with per-entry-type `required`/`section`/applicability.
   The flight "quick" set (shown without opening **More**) is capped at 12 by a
   test, and is **at** the cap.

---

## 5. Domain rules (settled — do not relitigate)

**Durations are integer minutes of LOGGED time.** A 58-minute flight logged as
1.0 is stored as 60. One tenth = exactly 6 minutes, so tenths are lossless. The
pilot's duration is the truth; block times only suggest it.

**Display.** Decimal hours by default (hh:mm as a setting); 24-hour clock by
default (12-hour as a setting). **Exports never depend on a display setting**:
JSON writes minutes, CSV writes decimal hours to one place.

**Times are stored as UTC `HH:MM`, dates as ISO.** The entry form's zone
selector is a typing aid only — it converts to UTC (including the date) before
storing.

**Simulator time is never flight time.** Never in flight totals, never in
currency, never in an aircraft column. FSTD is a mode of the entry form (a
Flight / Simulator toggle), aerodromes become `"SIM"`, the device ID goes in
`simulatorRegistration`. The list can hide FSTD entries; exports always include
them. If ICAO input is ever made strict, `"SIM"` must stay valid.

**SE/ME is filed at entry from the aircraft's class** and stored. An unknown
registration asks once; skipped, it falls back to `defaultAircraftClass`
(default ME).

**A pilot cannot be in two places at once.** `findConflicts` in
`domain/conflicts.ts` is the single definition, called by both the entry form
and the importer. Absolute date+time timeline (crossing midnight works),
touching is not overlapping, registration ignored, FSTD and zero-duration
entries never conflict. Advisory on the form (never blocks a save); pauses the
import once for the whole file, grouped into clusters.

**Component times over the total** give a soft warning (`domain/timeSums.ts`),
never a block — except the Phase 1 hard caps on PIC, multi-pilot and night.

**Night is sun altitude below −6°** (EASA civil twilight).
`CIVIL_TWILIGHT_DEGREES` in `night/solar.ts` is the one place it lives, checked
against US Naval Observatory tables in `night/solar.usno.test.ts`. The aircraft
walks the great circle between the aerodromes, sun altitude evaluated each
minute, crossings refined to the second. Stated assumptions: sea level, taxi
ignored for the minutes, take-offs not stored. The airport list is **bundled,
never fetched**. **There is one night calculation** — `suggestNightForEntry` —
used by the form, the import and the toolbox. The pilot's figure always wins.

**The landing column.** A Pilot Flying / Pilot Monitoring toggle sets one or
zero landings; the app puts it in Ldg Day or Ldg Night by the sun at arrival.
When twilight fell inside the unrecorded taxi window (`arrivalUncertain`), it
asks the pilot. `arrivalUncertain` (the landing instant) and `grazing` (the
minutes) are different things — never conflate them. PF/PM is recovered from
the counts, not stored; storing it would be a schema v4 decision.

**Currency** (90-day passenger carrying) reads the class off the flight's own
stored SE/ME/multi-pilot minutes. Take-offs are inferred from landings — a
disclosed assumption.

**Opening balance** applies to all-time totals only (never ranges, groupings or
currency). It travels in the JSON backup only when non-zero.

---

## 6. Features

**Entry form.** Quick fields inline, the rest under **More**. Block times fill
the total; wand buttons copy the total into a column. `2336` → `23:36`. Night
and the landing column are suggested and overridable; on a saved flight the
pilot can take the calculation or keep their logged figure.

**List.** Search (remarks, aerodromes, registration, type), filters, simulator
toggle, footer total including the opening balance (marked `+bf`).

**Totals and currency** in their own view.

**Printable EASA facsimile.** Durations always hh:mm (the form has hours and
minutes columns). Take-off columns are left blank — the app does not print
numbers it does not hold. Column widths are a deliberate rebalance of the
reference layout (more room for remarks).

**Export / backup.** JSON (lossless, canonical backup) and CSV (EASA columns,
best-effort). The share sheet is used where available. Backup reminder in the UI.

**Restore (JSON)** is all-or-nothing: `readBackup` vets the whole file first
(pure), `restoreBackup` replaces both tables in one Dexie transaction. States
both sides in counts, focuses Cancel, offers "Back up first". Does not write
`lastBackupAt`.

**CSV import** — *may transform, but never invisibly*. A wizard: file → mapping
(sniffed delimiter, BOM, duration unit, decimal mark; editable) → aircraft step
(per TYPE, plus untyped registrations) → conflict pause (fix or drop rows in
place) → preview → one all-or-nothing transaction. It merges, never clears.
`checkDurationSanity` compares totals against the file's own block times and
stops a minutes-read-as-hours mistake. Simulator rows never contribute flight
time; discarded values are parked in `extra`. Multi-pilot flights with no
function time are logged as co-pilot time, stated as a refusable claim.
Presets: **RB Logbook** and this app's own CSV.

**Airside import.** An airline crew-app export that cannot be mapped, so
`import/airside/` rewrites it first into an ordinary table: unpacks the
`Flight` cell (number-date-IATA-IATA), maps IATA → ICAO via the bundled list,
re-hyphenates registrations for known prefixes (an explicitly incomplete list —
unknown ones are left alone), and converts two local clocks to UTC. The pilot
names an IANA zone for one aerodrome; `Intl` supplies the rules, and the file's
own totals propagate offsets to the rest (`anchor` → `route` → `propagated` →
`bracketed`, leftovers marked `assumed`). Night is computed at import.

**Toolbox** (wrench in the list bar — it rewrites the logbook, so not in
Settings). Two cards, same shape: scope, date range, count, a reviewable list
with every row ticked, confirmation in numbers, one transaction, no undo.
- **Bulk adjust** — EASA column filing: *add* puts the whole time in a column,
  *remove* zeroes it. Exact matching. No VFR column (VFR = not IFR).
- **Work out night time** — the same `suggestNightForEntry`; "only flights with
  no night" (default) or "all flights". Night minutes only — landing columns
  untouched. Unresolvable flights are counted and named.

**Settings.** Duration display, clock format, spreadsheet format, default
aircraft class, opening balance. **Delete all data** sits in a Danger zone and
needs the word DELETE typed; it keeps display preferences and resets the backup
timestamp.

---

## 7. Testing

`npm test` — about 1,300 tests. `npm run check` — svelte-check. Component tests
use @testing-library/svelte; jsdom gaps (`Blob.text`, `matchMedia`,
`IntersectionObserver`) are polyfilled in `src/test/setup.ts`.

- **jsdom is not a browser.** It has no structured clone behind IndexedDB, so a
  Svelte `$state` proxy reaching storage passes every test and fails for real.
  Use `$state.raw` + `$state.snapshot` for anything written to storage, and
  click through anything that writes in a real browser.
- `testTimeout` is 30s, but it does **not** govern `vi.waitFor`/`findBy*`
  (1s default). Files waiting on the lazily imported airport chunk warm it in a
  `beforeAll`.
- Byte-exact export fixtures and the v1 fixtures are never edited to make a test
  pass; regenerating them is a reviewed change.
- `*.probe.test.ts` files are gitignored and read real logbooks from `private/`.

**Personal data rule.** Real logbook exports live outside the repo (`private/`,
gitignored). Every committed fixture is synthetic. No real flight — row, date,
route, registration or aggregate — goes into code, tests or these notes.

---

## 8. Environment (Windows)

- Node LTS; npm installs into the project only.
- PowerShell script execution was enabled with
  `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`.
- Never run npm as Administrator.
- Git Bash's `sed -i` strips CRLF — CSV fixtures under
  `src/lib/import/fixtures/` must keep CRLF (`.gitattributes` marks them
  `-text`); edit them with `sed -b` or a proper editor.
- Commits use the GitHub no-reply address
  `291600274+smoxey@users.noreply.github.com`.
