<script lang="ts">
  interface Props {
    value: number;
    id?: string;
    invalid?: boolean;
    /**
     * Fired when the PILOT changes the count, never when the app does. The
     * night calculation moves a landing into the night column while these are
     * untouched, and has to stop the moment they are not.
     */
    onUserEdit?: () => void;
  }

  let { value = $bindable(0), id, invalid = false, onUserEdit = () => {} }: Props = $props();

  function set(next: number) {
    value = Math.max(0, Math.floor(Number.isFinite(next) ? next : 0));
    onUserEdit();
  }

  function onInput(raw: string) {
    const t = raw.trim();
    if (t === '') {
      value = 0;
      onUserEdit();
      return;
    }
    const n = Number(t);
    if (Number.isInteger(n) && n >= 0) {
      value = n;
      onUserEdit();
    }
  }
</script>

<div class="stepper" class:invalid>
  <button type="button" class="pm" aria-label="Decrease" onclick={() => set(value - 1)} tabindex="-1">
    −
  </button>
  <input
    {id}
    class="mono field"
    type="text"
    inputmode="numeric"
    autocomplete="off"
    aria-invalid={invalid}
    value={value}
    oninput={(e) => onInput(e.currentTarget.value)}
    onblur={(e) => set(Number(e.currentTarget.value))}
  />
  <button type="button" class="pm" aria-label="Increase" onclick={() => set(value + 1)} tabindex="-1">
    +
  </button>
</div>

<style>
  .stepper {
    display: flex;
    align-items: stretch;
    gap: 0.4rem;
    max-width: 190px;
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
  .stepper.invalid .field {
    border-color: var(--danger);
  }
</style>
