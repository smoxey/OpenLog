<script lang="ts">
  /**
   * A time of day, typed and shown on the pilot's chosen clock.
   *
   * The bound value is ALWAYS the canonical 24-hour `"HH:MM"` the logbook
   * stores. This component only decides how those four digits are painted and
   * what typing is accepted for them — it knows nothing about UTC or local
   * time; the form above it owns that.
   *
   * WHY NOT `<input type="time">`: because its clock is the browser's, taken
   * from the operating system's locale, and there is no attribute that says
   * "24-hour". A pilot on a US-locale phone got `11:36 PM` in a logbook that
   * runs on `2336` and no setting in this app could change it. A text field
   * costs the native picker wheel and buys back a format the app can actually
   * promise — and for the four digits off a clock, a numeric keypad is the
   * faster instrument anyway.
   *
   * Built on the same shape as `DurationInput`: the visible text is local
   * state, re-synced from the value whenever the field is not being typed in,
   * so a suggestion arriving from elsewhere lands without fighting the cursor.
   */
  import { formatTimeOfDay, parseTimeOfDayInput, type ClockDisplay } from '../time/timeOfDay';

  interface Props {
    /** Canonical `"HH:MM"`, 24-hour. `''` when the field is empty. */
    value: string;
    clock: ClockDisplay;
    id?: string;
    describedby?: string;
    invalid?: boolean;
    /** Fired on user-driven edits only, never on a programmatic value change. */
    onUserEdit?: () => void;
  }

  let {
    value = $bindable(''),
    clock,
    id,
    describedby,
    invalid = false,
    onUserEdit = () => {},
  }: Props = $props();

  let text = $state(formatTimeOfDay(value, clock));
  let focused = $state(false);
  let parseError = $state('');

  // Re-sync the visible text when the value or the clock changes from the
  // outside — a zone switch rewrites both block times — but never mid-keystroke.
  $effect(() => {
    const v = value;
    const c = clock;
    if (!focused) {
      text = formatTimeOfDay(v, c);
      parseError = '';
    }
  });

  const placeholder = $derived(clock === '12h' ? '11:36 PM' : '23:36');

  function commitText(next: string) {
    text = next;
    const parsed = parseTimeOfDayInput(next);
    if (parsed === null) {
      parseError = clock === '12h' ? 'Use h:mm am/pm, e.g. 11:36 PM' : 'Use hh:mm, e.g. 23:36';
      return;
    }
    parseError = '';
    value = parsed;
    onUserEdit();
  }

  function onFocus() {
    focused = true;
  }

  function onBlur() {
    focused = false;
    // Snap back to the canonical rendering, so "936" becomes "09:36" in front
    // of the pilot rather than being quietly reinterpreted after they look away.
    if (!parseError) text = formatTimeOfDay(value, clock);
  }
</script>

<input
  {id}
  class="mono time"
  class:invalid={invalid || !!parseError}
  type="text"
  inputmode="numeric"
  autocomplete="off"
  autocapitalize="none"
  spellcheck="false"
  {placeholder}
  aria-describedby={describedby}
  aria-invalid={invalid || !!parseError}
  value={text}
  oninput={(e) => commitText(e.currentTarget.value)}
  onfocus={onFocus}
  onblur={onBlur}
/>
{#if parseError}
  <p class="parse-error" role="alert">{parseError}</p>
{/if}

<style>
  .time {
    width: 100%;
    min-height: var(--touch);
    padding: 0.5rem 0.65rem;
    font-size: 1.1rem;
    letter-spacing: 0.06em;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: border-color var(--speed) ease;
  }
  .time.invalid {
    border-color: var(--danger);
  }
  .parse-error {
    margin: 0.35rem 0 0;
    color: var(--danger);
    font-size: 0.82rem;
  }
</style>
