<script lang="ts">
  import { loadSettings, settings } from './lib/stores/settings.svelte';
  import FlightList from './lib/ui/FlightList.svelte';
  import FlightForm from './lib/ui/FlightForm.svelte';
  import SettingsPanel from './lib/ui/SettingsPanel.svelte';
  import ExportPanel from './lib/ui/ExportPanel.svelte';
  import ImportPanel from './lib/ui/ImportPanel.svelte';
  import TotalsPanel from './lib/ui/TotalsPanel.svelte';
  import PrintPanel from './lib/ui/PrintPanel.svelte';
  import ToolboxPanel from './lib/ui/ToolboxPanel.svelte';

  type View = 'list' | 'form' | 'settings' | 'export' | 'import' | 'totals' | 'print' | 'tools';

  let view = $state<View>('list');
  let editingId = $state<string | null>(null);
  /** Kept so the export view can decide whether a "never backed up" warning is warranted. */
  let flightCount = $state(0);

  // Load persisted settings before the first render of data-dependent views.
  loadSettings();

  function openAdd() {
    editingId = null;
    view = 'form';
  }
  function openEdit(id: string) {
    editingId = id;
    view = 'form';
  }
  function goList() {
    view = 'list';
  }
  function openSettings() {
    view = 'settings';
  }
  function openExport() {
    view = 'export';
  }
  function openImport() {
    view = 'import';
  }
  function openTotals() {
    view = 'totals';
  }
  function openPrint() {
    view = 'print';
  }
  function openTools() {
    view = 'tools';
  }
</script>

{#if !settings.ready}
  <div class="boot">Open Pilot Logbook…</div>
{:else if view === 'list'}
  <FlightList
    onAdd={openAdd}
    onEdit={openEdit}
    onSettings={openSettings}
    onExport={openExport}
    onTotals={openTotals}
    onTools={openTools}
    onCount={(n) => (flightCount = n)}
  />
{:else if view === 'form'}
  <!-- key on editingId so switching add<->edit fully re-initialises the form -->
  {#key editingId}
    <FlightForm flightId={editingId} onDone={goList} onCancel={goList} />
  {/key}
{:else if view === 'settings'}
  <SettingsPanel onBack={goList} onExport={openExport} onDataDeleted={goList} />
{:else if view === 'export'}
  <ExportPanel onBack={goList} {flightCount} onImport={openImport} onPrint={openPrint} />
{:else if view === 'print'}
  <PrintPanel onBack={openExport} />
{:else if view === 'tools'}
  <!--
    Bulk operations. Reached from the list rather than from Settings: these
    change the logbook itself, and Settings is where things that change how the
    logbook is DISPLAYED live.
  -->
  <ToolboxPanel onBack={goList} onExport={openExport} />
{:else if view === 'totals'}
  <TotalsPanel onBack={goList} onSettings={openSettings} />
{:else if view === 'import'}
  <ImportPanel onBack={openExport} onRestore={openExport} onImported={goList} />
{/if}

<style>
  .boot {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    color: var(--text-muted);
  }
</style>
