<script lang="ts">
  import { formatDuration, parseDurationInput, type DurationDisplay } from '../format';

  interface Props {
    /** The bound value is ALWAYS integer minutes. */
    value: number;
    mode: DurationDisplay;
    id?: string;
    describedby?: string;
    invalid?: boolean;
    /** Fired only on user-driven edits (typing / +-), not on programmatic value changes. */
    onUserEdit?: () => void;
  }

  let {
    value = $bindable(0),
    mode,
    id,
    describedby,
    invalid = false,
    onUserEdit = () => {},
  }: Props = $props();

  let text = $state(formatDuration(value, mode));
  let focused = $state(false);
  let parseError = $state('');

  // Re-sync the visible text when the value or format changes from the outside
  // (e.g. the auto-suggested total), but never while the user is typing.
  $effect(() => {
    const v = value;
    const m = mode;
    if (!focused) {
      text = formatDuration(v, m);
      parseError = '';
    }
  });

  // One tenth of an hour in decimal mode; one minute in hh:mm mode.
  const step = $derived(mode === 'hhmm' ? 1 : 6);

  function commitText(next: string) {
    text = next;
    const parsed = parseDurationInput(next, mode);
    if (parsed === null) {
      parseError = mode === 'hhmm' ? 'Use h:mm, e.g. 1:25' : 'Enter a number, e.g. 1.5';
      return;
    }
    parseError = '';
    value = parsed;
    onUserEdit();
  }

  function nudge(delta: number) {
    const next = Math.max(0, value + delta);
    value = next;
    text = formatDuration(next, mode);
    parseError = '';
    onUserEdit();
  }

  function onFocus() {
    focused = true;
  }
  function onBlur() {
    focused = false;
    if (!parseError) text = formatDuration(value, mode);
  }
</script>

<div class="duration" class:invalid={invalid || !!parseError}>
  <button
    type="button"
    class="pm"
    aria-label="Decrease"
    onclick={() => nudge(-step)}
    tabindex="-1"
  >
    −
  </button>
  <input
    {id}
    class="mono field"
    type="text"
    inputmode="decimal"
    autocomplete="off"
    aria-describedby={describedby}
    aria-invalid={invalid || !!parseError}
    value={text}
    oninput={(e) => commitText(e.currentTarget.value)}
    onfocus={onFocus}
    onblur={onBlur}
  />
  <button
    type="button"
    class="pm"
    aria-label="Increase"
    onclick={() => nudge(step)}
    tabindex="-1"
  >
    +
  </button>
</div>
{#if parseError}
  <p class="parse-error" role="alert">{parseError}</p>
{/if}

<style>
  .duration {
    display: flex;
    align-items: stretch;
    gap: 0.4rem;
  }
  .pm {
    flex: 0 0 var(--touch);
    min-width: var(--touch);
    height: var(--touch);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    font-size: 1.5rem;
    line-height: 1;
    transition:
      background var(--speed) ease,
      transform var(--speed) ease;
  }
  .pm:hover {
    background: var(--accent-soft);
  }
  .pm:active {
    transform: translateY(1px);
  }
  .field {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    height: var(--touch);
    text-align: center;
    font-size: 1.1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    padding: 0 0.4rem;
  }
  .duration.invalid .field {
    border-color: var(--danger);
  }
  .parse-error {
    margin: 0.35rem 0 0;
    color: var(--danger);
    font-size: 0.82rem;
  }
</style>
