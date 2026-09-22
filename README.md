# Open Pilot Logbook

An open source, **privacy-focused, local-first** EASA-format pilot logbook, built
as an installable Progressive Web App (PWA).

> **Your data never leaves your device.** There is no backend, no account, and no
> network call for your logbook data. Everything lives in your browser's
> IndexedDB. You back up by writing a file you keep.

---

## Contents

- [What it does](#what-it-does)
- [Install it on your phone](#install-it-on-your-phone)
- [Logging a flight](#logging-a-flight)
- [Simulator sessions](#simulator-sessions)
- [Automatic night time](#automatic-night-time)
- [Importing a logbook from another app](#importing-a-logbook-from-another-app)
- [Backing up, restoring and exporting](#backing-up-restoring-and-exporting)
- [Totals and currency](#totals-and-currency)
- [Printing an EASA logbook page](#printing-an-easa-logbook-page)
- [The toolbox — bulk changes](#the-toolbox--bulk-changes)
- [Settings](#settings)
- [Deleting everything](#deleting-everything)
- [For developers](#for-developers)

---

## What it does

- **EASA-format entries** — the full core column set, with everything beyond the
  common few tucked behind a **More** disclosure so ordinary entry stays fast.
- **Automatic night time**, worked out from the route and the block times —
  including which column your landing belongs in, and a straight answer when
  that is too close to call.
- **Simulator (FSTD) sessions**, kept rigorously separate from flight time.
- **CSV import** from another logbook, with a mapping step you can correct.
- **JSON backup and restore**, plus **CSV export** for spreadsheets.
- **Totals and 90-day passenger-carrying currency.**
- **A printable EASA logbook facsimile.**
- **Bulk tools** for fixing a logbook you have already written.
- **Works fully offline** once installed.

### What it deliberately does not do

- No account, no sync, no cloud. **There is no copy of your logbook anywhere but
  your device and the backups you write.**
- No telemetry, no analytics, no third-party scripts.
- It does not print numbers it does not hold — the take-off columns on the EASA
  page are left blank, because the app records landings and not take-offs.

---

## Install it on your phone

The app is a PWA: you install it from the browser, not from an app store.

> **Install from:** <https://smoxey.github.io/OpenLog/>
>
> Every push to `main` is tested, built and published there automatically, and
> an installed copy picks up the new version the next time it is opened online.

**iPhone / iPad (Safari)**
1. Open the app's URL in **Safari** (not Chrome — only Safari can install a PWA
   on iOS).
2. Tap the **Share** button.
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**. It now behaves like an app and works offline.

**Android (Chrome)**
1. Open the app's URL in Chrome.
2. Tap the **⋮** menu → **Install app** (or **Add to Home screen**).
3. Confirm.

**Desktop (Chrome, Edge)**
Look for the install icon in the address bar, or **⋮** menu → **Install**.

> **Storage lives with the browser profile that installed it.** A logbook added
> in Safari is not visible to Chrome on the same phone. Pick one browser and
> stay with it — and take a backup before changing devices.

---

## Logging a flight

Tap the **+** button on the list.

The form opens on the handful of fields most flights need — date, aerodromes,
block times, aircraft, and the totals. Two conveniences save most of the typing:

- **Block times fill the total.** Enter off-block and on-block and the total is
  suggested. Type over it whenever it is wrong; once you do, it stops
  suggesting.
- **The wand ✨ beside a time column copies the total into it** — the usual case
  for PIC or multi-pilot time.

**Times are 24-hour.** Type `2336` and it becomes `23:36`; `936` becomes
`09:36`. If you would rather read and write am/pm, there is a
[setting](#settings) for it — and the field still accepts `2336` either way.

**Block times are UTC unless you say otherwise.** Under the block-time fields
is a selector for the zone you are typing in. Leave it on **UTC (Zulu)** and
nothing is converted. Pick a local zone and the app subtracts the offset for
you, showing the UTC it will store under each field as you type — including the
date, because a flight departing at 01:30 local at UTC+02:00 departed the
previous day in UTC and is logged there. Your choice is remembered for the next
entry. **The logbook itself always holds UTC**; local time is a way of typing,
never a way of storing.

**Landings, and who was flying.** Above the two landing counts is a **Pilot
Flying / Pilot Monitoring** toggle. Pilot flying logs one landing; pilot
monitoring logs none. **Ldg Day and Ldg Night sit side by side**, and the app
puts the landing in whichever column the sun says — see
[Automatic night time](#automatic-night-time). Both counts stay editable, so
type over them for touch-and-goes or anything else the toggle does not cover.

Everything else EASA asks for is under **More**, which tells you how many further
columns it holds.

**Aircraft.** Enter a registration and the app remembers its type and class. On a
registration it has not seen, it asks once whether the aircraft is single- or
multi-engine, then files the flight's time into the SE or ME column accordingly.
That classification is **stored on the flight**, not looked up later: correcting
an aircraft's class next year will not silently rewrite flights logged this year.

**Warnings, never blocks.** If a flight overlaps another already in the logbook,
or the component times sum to more than the total, the form says so and still
lets you save. It is your logbook.

**Editing.** Tap any entry in the list to open it. Opening a saved flight never
rewrites what you logged.

**Finding a flight.** The list has a search box covering remarks, aerodromes,
registration and type, plus filters for aircraft type, registration, aerodrome
and a date range.

---

## Simulator sessions

The entry form has a **Flight / Simulator** toggle at the top.

A simulator session stores its time in `simulatorMinutes` and **never** in
`totalMinutes`. Simulator time is shown separately everywhere — its own block in
Totals — and is never added into flight time, never counted for currency, and
never printed in an aircraft column.

Simulator entries are shown in the list by default. The **simulator toggle in
the list bar** hides them; the entry count tells you how many are hidden.

---

## Automatic night time

The app works night time out for you, from the date, the two block times and the
two aerodromes.

**How.** Night is **sun altitude below −6°** — the EASA definition, the period
between the end of evening civil twilight and the beginning of morning civil
twilight. The aircraft is walked along the great circle between the two
aerodromes, the sun's altitude is evaluated once a minute along the way, and each
crossing of the threshold is refined to the second.

Three assumptions, stated rather than hidden:

- **Sea level.** At cruise the horizon dips and twilight lasts longer, so this
  reads slightly *less* night than you actually saw. The logbook records no
  cruise altitude, and the aerodrome-based definition means the ground.
- **Taxi is ignored** — off-block at the departure aerodrome, on-block at the
  arrival one. Small for a duration. **Not small for the landing column**, which
  is why the app asks about it — see below.
- **Take-offs are not stored.** Whether the departure was in the dark is shown
  under the field and nowhere else, because the schema has no take-off column.

**Accuracy.** The −6° calculation is checked against the **US Naval
Observatory's** published civil twilight times: 72 site-days from Svalbard to
Ushuaia, 128 twilight times, all within a minute, with no bias. On the eight
polar site-days where the USNO reports no civil twilight at all, the app finds
none either.

**It suggests; it never decides.** The figure fills the field while you have not
touched it and stops the moment you do. The **🌙 button** works it out on demand.
The airport list is bundled with the app — **no network request is ever made** —
and covers 39,243 aerodromes worldwide, ICAO codes with IATA aliases. An
aerodrome it does not have produces a plain message, never a guess.

**On a flight you already logged, you choose.** If your recorded night time and
the calculation disagree, the field keeps *your* figure and offers the other:

> Night `1.0` 🌙
> *From the route: take-off day, landing night, sea level.*
> **Use 1.3 from the route**

Take it, and the offer reverses to **Keep the 1.0 you logged**, so the choice is
reversible. Restoring your own figure counts as editing the field, so a later
change to a block time will not quietly undo it.

**Which column your landing goes in, and when the app admits it is guessing.**
A night arrival puts the landing in the Ldg Night column, a day arrival in Ldg
Day. But you did not land at on-block — you landed some minutes earlier, and
your logbook does not record the taxi. When the sun was near the horizon at
block-in, the column is a guess, so the app says so instead of filing it
quietly:

> **Sun close to the horizon at EGLL — is this landing in the right column?**
> Taxi time is not logged, so the app cannot tell which side of civil twilight
> the wheels touched down on. It has put 1 landing in the **night** column.
>
> **No — it was day**  |  **Yes — night landing**

Both answers are one tap, and neither is required: the counts are already filled
in and the flight saves either way. **Yes** just stops it asking. **No** moves
the landing across and leaves it there. If you then change a block time enough to
move the answer, it asks again — because what you confirmed was about a different
landing.

You were there and the app was not, so the fields are always yours: type over
either count at any point and the app stops moving them.

**A note if you are coming from another logbook.** This app applies the −6°
definition strictly. Some logbook software is more generous on dark
high-latitude winter sectors, where the sun tracks just under the horizon for
hours — so on those flights this app will suggest **less** night than your old
logbook recorded, and the two will not tie out. That is the definition doing its
job, and the field is always yours to overrule.

Turn the offering off entirely in **Settings → Night time**. The 🌙 button keeps
working either way.

---

## Importing a logbook from another app

**Back up first if you already have entries.** Import adds to your logbook; it
does not replace it.

Go to **⤓ (Back up and export) → Import from another logbook → Import a CSV…**

The wizard has four steps — five for an **Airside** file, which needs one
question answered first:

1. **Choose a CSV file.** The app recognises exports from **RB Logbook**,
   **Airside** and **Open Pilot Logbook** itself, and applies a starting mapping
   automatically. Anything else, you map by hand.
2. **Columns.** Every column in the file is listed with where it is going. A
   recognised format is a *starting point, never a commitment* — check it and
   correct anything wrong before continuing. Columns you do not want go to
   **Ignore**. This step also asks two things about the file that the app cannot
   safely guess: **what unit its durations are in**, and **what zone its block
   times are in**. Both show a worked example off a real row of your own file so
   you can see what the answer does before it is applied. Block times default to
   **UTC**, which is what most logbooks record — if yours records local time,
   say which zone here and the app converts, moving the date on any sector that
   departs after local midnight.
3. **Aircraft.** Every aircraft in the file, with its type and class. Rows whose
   aircraft type is blank are called out, because they need a human. Fix them
   here rather than in 400 individual entries afterwards.
4. **What will be imported.** Counts, and a list of any rows that will be left
   out and why. Nothing is written until you confirm.

### Airside files get an extra step

An Airside export packs four values into one `Flight` column, names aerodromes
by their three-letter IATA code, writes registrations without their hyphen, and
records block times on **local clocks** — the departure aerodrome's for the
off-block, the arrival aerodrome's for the on-block. None of that can be
expressed by mapping a column to a field, so the file is rewritten first, and
the extra step is where you check the rewriting:

- **Which clock the times are on.** Name the time zone of one aerodrome you fly
  from — your base — and the app works the rest out from the file's own numbers:
  the difference between a row's block times and its total flight time *is* the
  difference between the two aerodromes' zones. It tells you how many rows it
  solved and how many it had to assume, and you can name more aerodromes until
  nothing is assumed. Rows it had to assume are listed by line, and marked on the
  record itself, so a later doubt about an hour has somewhere to start.
- **Registrations.** `SEXYZ` becomes `SE-XYZ`, for the country prefixes the app
  is confident about. Anything else is left exactly as written and listed.
- **Aircraft types.** The airline's model code — `32N`, `319` — with the ICAO
  designator it will be stored as, editable.
- **Night time.** Airside records none, so the app offers to work it out from the
  route and the clock and to put each landing in the Day or Night column
  accordingly. This is the only place both halves of that answer can be given at
  once: the toolbox can fill night time in later, but it never moves a landing.

The next step then shows you the rewritten file, column by column, like any
other import — nothing is hidden behind the Airside step, and you can go back
and change any answer.

**Two things the importer is careful about**, both learned from a real
export:

- **Simulator rows are detected and kept separate.** A logbook that puts block
  time on simulator rows would otherwise add hours of flight time that was never
  flown.
- **An aircraft identifier column can mean two different things** — a
  registration on a flight, a device id on a simulator session — and is routed
  accordingly, so simulators never end up in your aircraft list.

---

## Backing up, restoring and exporting

Reached from **⤓** in the list bar.

### JSON backup — the real one

**This is the canonical format and the only complete one.** It carries flights,
aircraft and your opening balance in one envelope, and restoring it reproduces
your logbook exactly.

- **Share JSON** — hand it to Mail, Files, Drive, AirDrop, whatever your device
  offers.
- **Download JSON** — save it locally.

The app tracks when you last backed up and reminds you on the list when it has
been a while.

### CSV for spreadsheets

For opening in Excel, Numbers or Google Sheets, or for moving into another app.
**It is not a full backup** — CSV is one flat table, so some structure does not
survive the trip, and the panel tells you exactly what is left out.

If your spreadsheet software expects a particular separator, set
**Settings → Spreadsheet format**.

### Restore

**Back up, restore & import → Restore from backup.** Load a JSON backup written
by this app — on a new phone, or after clearing your browser.

Restore is **all-or-nothing**: a damaged file changes nothing, and a successful
restore replaces the logbook wholesale rather than merging into it. The
confirmation states what is about to happen in concrete counts before anything
is written.

> **Moving to a new phone:** back up to JSON on the old device, get the file
> across however you like, install the app on the new device, then restore.

A freshly restored device will say it has **never been backed up**. That is
correct, not a bug: the restored data has never been exported *from this*
device, and the file you restored from may be two years old.

---

## Totals and currency

**Σ** in the list bar.

- **Totals** across every EASA column, for all time or a date range, and
  optionally grouped by aircraft type or by registration.
- **Simulator time** in its own block, never added into flight time.
- **90-day passenger-carrying currency**, per class or type, per FCL.060(b)(1).

Two things to know about currency:

- **Take-offs are inferred from landings.** The regulation wants three take-offs
  *and* three landings; the logbook stores only landings. Counting them as one
  figure is the standard reading, and it is an assumption — it is the first thing
  to check if a currency figure ever looks wrong.
- **The app reports a calculation from what you have logged. You remain
  responsible for your own currency.**

### Hours from a previous logbook

**Settings → Previous logbook** takes an opening balance, one field per column.
It applies to **all-time totals only** — never to a date range, a grouping, or
currency, because a brought-forward figure has no date and no aircraft. Where the
list footer includes it, it is marked `+bf`.

The opening balance travels in the JSON backup, so it survives a move to a new
device.

---

## Printing an EASA logbook page

**⤓ (Back up and export) → Print an EASA logbook.**

Pick a date range and print. The output is a facsimile of the EASA layout: two
landscape sheets per logbook page, eight rows a page, running totals carried
forward, and the certification block and signature line.

Print to paper or to PDF using your browser's own print dialog.

> **Two columns are deliberately left blank.** The **take-off** columns, because
> the app records landings and not take-offs; and a simulator session's
> **aircraft** column, because a simulator is not an aircraft. This is a page you
> sign — it will not invent a number.

Durations print as `hh:mm` regardless of your display setting, because the EASA
form is ruled with an hours column and a minutes column.

---

## The toolbox — bulk changes

**🔧** in the list bar. Everything here **rewrites entries you have already
saved**, so it lives behind its own icon.

> **There is no undo.** Both tools offer **Back up first** in their confirmation,
> and you should take it.

Both tools work the same way, and the shape is the point:

1. Build the change.
2. **Read the count** — how many entries it affects, on screen before Apply can
   be pressed.
3. **Review every affected entry.** Each one has a checkbox, **ticked from the
   start**. Untick any row to leave that entry exactly as it was; the row stays
   in place, greyed, so you can tick it back.
4. **Confirm.** The dialog states the change in concrete numbers, says plainly
   there is no undo, and focuses Cancel.

The write is one transaction: it either lands completely or not at all.

### Bulk adjust time

For a column your previous logbook never recorded — *all my A320 time was
multi-pilot*.

- **Add** puts each entry's whole time into that column. **Remove** sets the
  column to zero. These are EASA **column-filing** operations, not arithmetic on
  an amount: an EASA logbook asks which column a flight's time belongs in, not
  how many hours to sprinkle into it.
- Match by **aircraft type** or **registration**, over all entries or a date
  range. Matching is **exact** — `A32` will not quietly take your A321s.
- **Total time is never touched.** You are reclassifying time, not creating any.
- There is no VFR column in an EASA logbook: time not logged as IFR *is* VFR. To
  mark flights VFR, remove their IFR time.

### Work out night time

Works night out for flights you logged before the app could do it — the same
calculation the entry form uses.

- **Only flights with no night** fills blanks and can never overwrite anything.
- **All flights** also shows the flights that already carry a figure, so you can
  see where the calculation disagrees with what was logged — and keep whichever
  you want, flight by flight.
- Every row reads `0.0 → 1.0` behind its tick, so keeping what you logged is one
  click.
- Flights where the sun sat close to the horizon are marked **close**: a minute
  either way is a judgement call there, not arithmetic.
- Flights it cannot work out — an aerodrome not in the list, missing block times
  — are **reported, never silently skipped**, with the missing codes named.
- **Night time only.** The day and night landing columns are not touched; that is
  a separate claim about a flight, and the entry form is where it belongs.

---

## Settings

**⚙︎** in the list bar.

| Setting | What it does |
|---|---|
| **Duration display** | Decimal hours (`1.5`) or `hh:mm` (`1:30`). Display only — storage is always whole minutes. |
| **Clock** | 24-hour (`23:36`) or 12-hour (`11:36 PM`). Display only — every record holds a 24-hour UTC time, and the printed EASA page stays 24-hour whichever you pick. |
| **Assumed aircraft class** | Where a flight's time goes when an aircraft's class is unknown and you skip the prompt. |
| **Night time** | Whether the form fills night in by itself. Off leaves the 🌙 button working. |
| **Spreadsheet format** | The separator used for CSV export, for software that expects a particular one. |
| **Previous logbook** | Your opening balance — see [Totals](#totals-and-currency). |
| **Backup** | When you last backed up, and a shortcut to do it now. |
| **Danger zone** | Delete all data. |

Settings are per device and, apart from the opening balance, do not travel in a
backup. No setting ever changes what a file contains.

---

## Deleting everything

**Settings → Danger zone → Delete all data.**

This removes every flight, every aircraft and your settings from this device.
There is no cloud copy and no undo — **the only way back is a backup file**. The
dialog offers to back up first without losing your place, and asks you to type a
confirmation, because this is the one operation with no innocent case.

---

## For developers

### Requirements

Node 18+ and npm.

### Getting started

```bash
npm install
npm run dev        # dev server
npm test           # the full suite
npm run check      # svelte-check / TypeScript
npm run build      # production build into dist/
npm run preview    # serve the built output
```

### Deploying

The build is a static site — any static host with HTTPS will do (HTTPS is
required for a service worker). GitHub Pages, Cloudflare Pages and Netlify all
work.

This repository deploys itself to GitHub Pages through
`.github/workflows/deploy.yml`: on every push to `main` it runs the tests, builds,
and publishes `dist/`. A failing test stops the deploy. On a fork, turn it on once
under **Settings → Pages → Source: GitHub Actions**.

The base path is one constant in `vite.config.ts`:

```ts
const BASE_PATH = process.env.BASE_PATH ?? '/OpenLog/';
```

Serving from a domain root instead of a project subpath:

```bash
BASE_PATH=/ npm run build
```

### Tech stack

- **Svelte 5** (runes) + **Vite** + **TypeScript**
- **Dexie.js** for IndexedDB
- **vite-plugin-pwa** for the service worker and manifest
- **Vitest** + **@testing-library/svelte** for tests
- Plain CSS with a token set

No runtime dependency fetches anything over the network.

### Architecture

```
src/lib/
  registry/   The field registry — the single source of truth for every column
  domain/     Pure logic: flights, aircraft, totals, currency, conflicts,
              migration, and the two bulk tools (bulkAdjust, bulkNight)
  night/      Solar position, great-circle path, the night calculation
  airports/   The bundled aerodrome list, its packed format, its generator,
              and the IATA -> ICAO pairing the Airside import needs
  import/     CSV parsing, column mapping, format presets, transformation
  import/airside/  One format that needs rewriting before it can be mapped
  export/     JSON backup envelope and CSV export
  storage/    The only half that knows Dexie exists
  validation/ One validator, run on every write
  ui/         Svelte components
  time/       Duration, block-time and time-zone helpers
```

Three rules the codebase holds to, worth knowing before changing it:

- **The registry is the contract.** New logbook columns are registry entries.
  Components ask the registry what applies to an entry type; they do not name
  fields.
- **Storage is isolated.** Only `lib/storage` touches Dexie. Domain code is pure
  and takes its inputs as arguments — which is what makes the night calculation
  and both bulk tools testable without a browser or a database.
- **Derived values are derived once, then stored.** A logbook is a historical
  record; nothing is recomputed on read.

### Tests

```bash
npm test
```

Tests ending in `.probe.test.ts` are gitignored by construction: they read a real
logbook out of `private/` and exist only on a machine that has one.

`night/solar.usno.test.ts` checks the twilight calculation against a committed
table of US Naval Observatory values. It needs no network — the table is a
fixture — and it is the one test in the project that checks the design against an
outside authority rather than against itself.

### Contributing

Issues and pull requests are welcome. The one non-negotiable: **nothing may send
logbook data over a network.** That is the whole premise, and a change that
breaks it will not be merged whatever else it does.

---

## Licence

MIT — see [LICENSE](LICENSE).
