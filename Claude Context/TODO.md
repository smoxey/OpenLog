# Open Pilot Logbook — to do

What is left, as of September 2026. Architecture and rules are in
`HOW_IT_WORKS.md`. Most of what remains needs a person, a device or a decision
rather than more code.

---

## 1. Verify on real devices (never done)

Everything below is proven in tests; none of it has been seen on a phone.
Two earlier phases each shipped a bug only a real browser caught.

- [ ] **Airside import, for real, in a browser.** Back up first — import
      merges. Check: does the IANA zone field (a `<datalist>` of ~600 names)
      work on a phone; does the coverage line make "name another aerodrome"
      obvious; does typing feel laggy (fix would be a debounce — measure
      first); do a few computed winter night figures look right.
- [ ] **Night feature click-through** — moon button as a finger target, the
      disabled `title` on a device that cannot hover, the explanation line, the
      keep-or-take offer on a saved flight.
- [ ] **Landing block layout** — two steppers side by side at 375px and
      narrower. Does the amber "is this landing in the right column?" question
      read as a question rather than a warning?
- [ ] **Toolbox night card** against a real logbook (back up first — no undo).
- [ ] **Backup round trip** — export on iOS Safari, mail it, restore on another
      device. Also re-import the CSV on desktop, open it in Excel and Google
      Sheets (accents, leading zeros, dates), and an airplane-mode cold start.
- [ ] **Print one page** and hold it against a real EASA form (column widths
      are a rebalance; 6.5pt type and browser margins unverified on paper).
- [ ] **Look at the design pass** (entry-type toggle, shadow tokens) — only
      verified by geometry so far.
- [ ] Stopwatch test: routine flight entry under 15 seconds, with FSTD toggle,
      conflict check and the extra fields in place.
- [ ] Confirm zero outbound network requests after first load (devtools).
- [ ] Lighthouse PWA audit. Real devices: iPhone, iPad, Android, desktop.

## 2. Check the numbers

- [ ] **Compare app totals against the real paper logbook**, with the real
      opening balance entered. Phase 4 is not finished until they match.
- [ ] **Check the currency calculation against the regulation text** —
      especially the take-offs-inferred-from-landings assumption. It is the one
      number whose being wrong is a safety problem.
- [ ] **Check the A320/A319 columns** the bulk-adjust tool produced read the
      way the pilot means them.

## 3. Decisions waiting on the pilot

- [ ] **Twilight threshold.** The app applies EASA −6° literally and is stricter
      than RB Logbook on dark high-latitude winter sectors, so it suggests less
      night there than the old logbook. Keep −6° (recommended: it is the
      regulation and unbiased) or not.
- [ ] **`32N` → `A320` or `A20N`** in the Airside step. Decide before importing.
- [ ] **Hard-cap overlap** — PIC over the total gives both the soft warning and
      the Phase 1 hard error. Leave it, drop the caps, or suppress the soft one.
- [ ] **`+bf` in the list footer** — keep the opening balance in the list total?
- [ ] **Blank take-off columns on the printed page** — confirm before signing.
- [ ] **Import judgement calls** — confirm the type-grouped aircraft step and the
      multi-pilot suggestion list (`TRANSPORT_TYPE`).
- [ ] **Single-flight delete** — hard delete (current precedent) or an undo
      window.
- [ ] **ICAO input strictness** — stay lenient, or enforce four letters (`"SIM"`
      must stay valid).

## 4. Known technical debt

- [ ] Near-duplicate detection ("same date, same registration, similar times")
      — postponed by decision, now due. `findConflicts` has no tolerance
      parameter by design.
- [ ] Conflict detection is O(n²) on import (~2.5 s for ~1,000 rows on desktop,
      no spinner). Fix: bucket candidates by day number.
- [ ] Our CSV export has no `id` column, so re-importing it duplicates rather
      than updates (the overlap check catches it). Adding one regenerates the
      export fixtures.
- [ ] Registration hyphen table for Airside covers only some registries — extend
      when a real file needs it.
- [ ] Airside import adds `Flight Number` and `Zone Assumed` columns to CSV
      export (via `extra`) — worth a look before it surprises someone.
- [ ] Airport chunk is ~594 kB raw / 364 kB gzipped; precache ~1 MB. Watch it.
- [ ] Totals after edit/delete — covered indirectly, no dedicated test.
- [ ] Accessibility: `ConfirmDialog` alertdialog needs a tabindex (svelte-check
      warning), plus a full keyboard/focus/contrast/screen-reader pass.

## 5. Polish (Phase 5 polish)

- [ ] Dark mode via the token set (system preference + manual override)
- [ ] Aircraft profiles UI — rename, merge duplicate registrations, variants
- [ ] EASA / FAA format setting
- [ ] Rounding preference (tenths / hh:mm entry)
- [ ] Optional "leave blank" for `defaultAircraftClass`
- [ ] Install experience: Android prompt, iOS "Add to Home Screen" hint in-app
- [ ] Service worker update UX — "new version available" instead of a silent swap
- [ ] Replace the placeholder app icons

## 6. Release (Phase 6)

- [x] GitHub Actions: test → build → deploy to Pages
- [x] README: what it is, privacy claim, install, backup
- [ ] Make the repository public (after the history clean-up)
- [ ] Explicit privacy statement, with how a reader can verify it
- [ ] Prominent iOS storage-eviction warning naming JSON as the real backup
- [ ] Screenshots
- [ ] Version number visible in the app, plus a changelog
- [ ] Issue templates and a contributing note
- [ ] Install from the live URL on a clean device and use it for a week
