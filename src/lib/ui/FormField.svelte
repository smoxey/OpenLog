<script lang="ts">
  import type { FieldDefinition } from '../registry/types';
  import type { DurationDisplay } from '../format';
  import type { ClockDisplay } from '../time/timeOfDay';
  import DurationInput from './DurationInput.svelte';
  import CountStepper from './CountStepper.svelte';
  import TimeInput from './TimeInput.svelte';

  interface Props {
    field: FieldDefinition;
    /**
     * Value type depends on field.type (string for text/date/time, number for
     * duration/count). Typed loosely so a single `bind:value` can forward to
     * whichever input this field maps to.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any;
    mode: DurationDisplay;
    /** Which clock a time-of-day field is shown and typed on. */
    clock?: ClockDisplay;
    error?: string;
    /** Show the "this was filled in for you" hint under the input. */
    suggested?: boolean;
    /**
     * The wording of that hint. Supplied by the caller because what filled the
     * field in differs — block times for the total, a sun calculation for
     * night — and a single sentence covering both would say nothing.
     */
    suggestedNote?: string;
    /**
     * Contextual hint replacing `field.inputHint` — e.g. where a derived value
     * came from. Empty string means "no override".
     */
    note?: string;
    /** Fired on user-driven duration edits (used to mark the total as touched). */
    onUserEdit?: () => void;
    /** Copy-total convenience action (rendered when field.copyTotalAction). */
    onCopyTotal?: () => void;
    /**
     * Accessible label for that action. The button is an icon, so this is the
     * only thing a screen reader gets — and what it copies FROM depends on the
     * entry type ("total time" on a flight, "session time" in a simulator), so
     * the caller supplies the wording.
     */
    copyLabel?: string;
    /** Work out night time from the route and times (when field.nightAction). */
    onNight?: () => void;
    /**
     * Why the night button cannot be used, or '' when it can. A reason rather
     * than a boolean: it is both the disabled state and the tooltip explaining
     * it, and a disabled control with no explanation is a dead end.
     */
    nightUnavailable?: string;
    /**
     * A one-press offer under the field, or '' for none.
     *
     * The field's own hint says what the app worked out; this is the button
     * that takes it, or takes it back. Night is its first user: a saved flight
     * shows what was logged beside what the route says, and this is how the
     * pilot picks between them without retyping either. A LABELLED button
     * rather than an icon, because unlike the actions beside the input this one
     * carries a number the pilot is agreeing to.
     */
    choiceLabel?: string;
    /** Fired when that offer is taken. */
    onChoice?: () => void;
    /**
     * Fired when a text value settles — on blur, or when a suggestion is picked
     * from the datalist. Used for the aircraft-registration lookup.
     */
    onCommit?: () => void;
    /** Autocomplete options for text fields (rendered as a native datalist). */
    suggestions?: readonly string[];
  }

  let {
    field,
    value = $bindable(),
    mode,
    clock = '24h',
    error = '',
    suggested = false,
    suggestedNote = 'Suggested from block times — edit to override',
    note = '',
    onUserEdit = () => {},
    onCopyTotal = () => {},
    copyLabel = 'Copy total time',
    onNight = () => {},
    nightUnavailable = '',
    choiceLabel = '',
    onChoice = () => {},
    onCommit = () => {},
    suggestions = [],
  }: Props = $props();

  const fieldId = `f-${field.key}`;
  const hintId = `${fieldId}-hint`;
  const errId = `${fieldId}-err`;
  const listId = `${fieldId}-list`;
  const describedby = $derived(error ? errId : field.inputHint ? hintId : undefined);
</script>

<div class="form-field" class:has-error={!!error}>
  <label for={fieldId}>
    {field.label}
    {#if field.required}<span class="req" aria-hidden="true">*</span>{/if}
  </label>

  <div class="control">
    {#if field.type === 'durationMinutes'}
      <div class="dur-row">
        <DurationInput
          id={fieldId}
          bind:value
          {mode}
          {describedby}
          invalid={!!error}
          {onUserEdit}
        />
        {#if field.copyTotalAction}
          <!--
            The wand: fill this field with the whole session in one tap. Icon
            only, so the accessible name comes from `copyLabel` and the title —
            what it copies from differs between a flight and a simulator entry.
          -->
          <button
            type="button"
            class="btn ghost copy"
            onclick={onCopyTotal}
            aria-label="{copyLabel} into {field.label}"
            title="{copyLabel} into {field.label}"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M6.5 17.5 17 7M14.8 4.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7zM5.6 9.1l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3L3.8 11l1.3-.5zM18.4 13.6l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z"
              />
            </svg>
          </button>
        {/if}
        {#if field.nightAction}
          <!--
            Work out night time from the date, the block times and the two
            aerodromes. Icon only, like the wand beside it; the title carries
            the reason when there is nothing it can do yet, so a disabled
            button is never a dead end.
          -->
          <button
            type="button"
            class="btn ghost copy night"
            onclick={onNight}
            disabled={!!nightUnavailable}
            aria-label="Work out night time"
            title={nightUnavailable || 'Work out night time from the route and times'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
              <circle cx="17.5" cy="5.5" r="1" />
              <circle cx="20.5" cy="9" r="0.75" />
            </svg>
          </button>
        {/if}
      </div>
    {:else if field.type === 'count'}
      <CountStepper id={fieldId} bind:value invalid={!!error} {onUserEdit} />
    {:else if field.type === 'remarks'}
      <textarea
        id={fieldId}
        bind:value
        placeholder={field.placeholder}
        rows="2"
        aria-invalid={!!error}
        aria-describedby={describedby}
      ></textarea>
    {:else if field.type === 'date'}
      <input
        id={fieldId}
        type="date"
        bind:value
        aria-invalid={!!error}
        aria-describedby={describedby}
      />
    {:else if field.type === 'timeOfDay'}
      <TimeInput id={fieldId} bind:value {clock} invalid={!!error} {describedby} />
    {:else if field.type === 'icao'}
      <input
        id={fieldId}
        type="text"
        class="icao"
        {value}
        placeholder={field.placeholder}
        autocapitalize="characters"
        autocomplete="off"
        spellcheck="false"
        maxlength="4"
        aria-invalid={!!error}
        aria-describedby={describedby}
        oninput={(e) => (value = e.currentTarget.value.toUpperCase())}
      />
    {:else}
      <input
        id={fieldId}
        type="text"
        bind:value
        placeholder={field.placeholder}
        autocomplete="off"
        list={suggestions.length ? listId : undefined}
        aria-invalid={!!error}
        aria-describedby={describedby}
        onblur={onCommit}
        onchange={onCommit}
      />
      {#if suggestions.length}
        <datalist id={listId}>
          {#each suggestions as option (option)}
            <option value={option}></option>
          {/each}
        </datalist>
      {/if}
    {/if}
  </div>

  {#if error}
    <p class="msg error" id={errId} role="alert">{error}</p>
  {:else if suggested}
    <p class="msg hint suggested">{suggestedNote}</p>
  {:else if note}
    <p class="msg hint derived" id={hintId}>{note}</p>
  {:else if field.inputHint}
    <p class="msg hint" id={hintId}>{field.inputHint}</p>
  {/if}

  <!--
    The offer sits BELOW whichever hint is showing rather than inside it: the
    hint explains, and this acts. Keeping them apart means an error message
    never swallows the button that would fix what it is complaining about.
  -->
  {#if choiceLabel}
    <p class="msg choice">
      <button type="button" class="choice-btn" onclick={onChoice}>{choiceLabel}</button>
    </p>
  {/if}
</div>

<style>
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  label {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .req {
    color: var(--accent);
    margin-left: 0.1rem;
  }
  input,
  textarea {
    width: 100%;
    min-height: var(--touch);
    padding: 0.5rem 0.65rem;
    font-size: 1rem;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: border-color var(--speed) ease;
  }
  textarea {
    resize: vertical;
    min-height: 3rem;
    font-family: inherit;
  }
  input.icao {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-family: var(--mono);
  }
  input[aria-invalid='true'],
  textarea[aria-invalid='true'] {
    border-color: var(--danger);
  }
  .dur-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .dur-row :global(.duration) {
    flex: 1 1 auto;
  }
  .copy {
    flex: 0 0 auto;
    /* Square: the label is an icon now, so width follows height rather than
       text. Still a full touch target. */
    width: var(--touch);
    height: var(--touch);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px dashed var(--border);
    white-space: nowrap;
  }
  .copy:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .copy svg {
    width: 1.15rem;
    height: 1.15rem;
    /* The wand is drawn as strokes plus filled sparkles; both follow the
       button's colour so it stays legible in either theme. */
    fill: currentColor;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }
  /* After `.copy svg`, which sets a stroke: the moon is a filled shape rather
     than strokes-plus-sparkles, and a stroked crescent loses its horns. */
  .night svg {
    stroke: none;
  }
  .msg {
    margin: 0;
    font-size: 0.82rem;
  }
  .msg.error {
    color: var(--danger);
  }
  .msg.hint {
    color: var(--text-faint);
  }
  .msg.suggested {
    color: var(--accent);
  }
  .msg.derived {
    color: var(--text-muted);
  }
  .msg.choice {
    margin-top: 0.15rem;
  }
  /*
    A text button, not a link: it changes a value in the form rather than going
    anywhere. Given a real target height on a coarse pointer, because on a phone
    this is the control the whole keep-or-change decision goes through.
  */
  .choice-btn {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--night);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .choice-btn:hover {
    text-decoration-thickness: 2px;
  }
  @media (pointer: coarse) {
    .choice-btn {
      padding: 0.35rem 0;
      min-height: 2rem;
    }
  }
</style>
