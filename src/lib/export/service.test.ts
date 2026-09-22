import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exportLogbook } from './service';
import { deliverExport, canShareFile, makeExportFile } from './share';
import { backupStatus, backupLabel } from './backupStatus';
import { exportFilename } from './filename';
import { SAMPLE_FLIGHTS, SAMPLE_AIRCRAFT } from './fixtures/sample-logbook';
import { getSettings, updateSettings } from '../storage';
import { db } from '../storage/db';
import type { DeliveryMode, DeliveryResult } from './share';

const NOW = new Date('2026-08-06T09:14:00.000Z');

/** jsdom's File does not implement `.text()`; FileReader is the portable read. */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

const bundle = { flights: SAMPLE_FLIGHTS, aircraft: SAMPLE_AIRCRAFT };

function deps(delivery: Partial<DeliveryResult>) {
  return {
    loadBundle: async () => bundle,
    now: () => NOW,
    appVersion: '0.1.0',
    // Parameters are declared so `mock.calls[0][0]` types as the File.
    deliver: vi.fn(
      async (_file: File, _mode: DeliveryMode): Promise<DeliveryResult> => ({
        ok: true,
        route: 'download' as const,
        cancelled: false,
        ...delivery,
      }),
    ),
  };
}

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
});

describe('lastBackupAt accounting', () => {
  it('is written on a successful export', async () => {
    const outcome = await exportLogbook('json', 'auto', deps({ ok: true }));
    expect(outcome.ok).toBe(true);
    expect(outcome.backedUpAt).toBe(NOW.toISOString());

    const settings = await getSettings();
    expect(settings.lastBackupAt).toBe(NOW.toISOString());
    expect(settings.lastBackupFormat).toBe('json');
  });

  it('is NOT written when the user cancels the share sheet', async () => {
    const outcome = await exportLogbook(
      'json',
      'share',
      deps({ ok: false, route: 'share', cancelled: true }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.cancelled).toBe(true);
    expect(outcome.backedUpAt).toBeNull();
    expect((await getSettings()).lastBackupAt).toBeNull();
  });

  it('is NOT written when delivery fails', async () => {
    const outcome = await exportLogbook(
      'csv',
      'share',
      deps({ ok: false, route: 'share', cancelled: false, error: 'nope' }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('nope');
    expect((await getSettings()).lastBackupAt).toBeNull();
  });

  it('is NOT written when the export itself throws', async () => {
    const outcome = await exportLogbook('json', 'auto', {
      ...deps({ ok: true }),
      loadBundle: async () => {
        throw new Error('database unavailable');
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('database unavailable');
    expect((await getSettings()).lastBackupAt).toBeNull();
  });

  it('does not overwrite an earlier backup timestamp on a cancelled export', async () => {
    await updateSettings({ lastBackupAt: '2026-01-01T00:00:00.000Z', lastBackupFormat: 'csv' });
    await exportLogbook('json', 'share', deps({ ok: false, route: 'share', cancelled: true }));
    expect((await getSettings()).lastBackupAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('export outcome', () => {
  it('names the file by kind and date', async () => {
    const json = await exportLogbook('json', 'auto', deps({ ok: true }));
    expect(json.filename).toBe('open-pilot-logbook-2026-08-06.json');
    const csv = await exportLogbook('csv', 'auto', deps({ ok: true }));
    expect(csv.filename).toBe('open-pilot-logbook-2026-08-06.csv');
  });

  it('surfaces CSV warnings and never produces them for JSON', async () => {
    const csv = await exportLogbook('csv', 'auto', deps({ ok: true }));
    expect(csv.warnings.map((w) => w.key).sort()).toEqual(['crew', 'waypoints']);

    const json = await exportLogbook('json', 'auto', deps({ ok: true }));
    expect(json.warnings).toEqual([]);
  });

  it('uses the persisted spreadsheet format for CSV', async () => {
    await updateSettings({ spreadsheetFormat: 'european' });
    const d = deps({ ok: true });
    await exportLogbook('csv', 'auto', d);
    const text = await readFileText(d.deliver.mock.calls[0][0]);
    expect(text).toContain('Date;Departure Place');
  });

  it('ignores the spreadsheet format for JSON', async () => {
    await updateSettings({ spreadsheetFormat: 'european' });
    const d = deps({ ok: true });
    await exportLogbook('json', 'auto', d);
    const text = await readFileText(d.deliver.mock.calls[0][0]);
    expect(JSON.parse(text).format).toBe('open-pilot-logbook');
    // Integer minutes, not a localized decimal.
    expect(text).toContain('"totalMinutes": 138');
  });
});

describe('share feature detection', () => {
  const original = { share: navigator.share, canShare: navigator.canShare };

  function setNavigator(share: unknown, canShare: unknown) {
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true });
  }

  // Restore after every case so other tests see a clean navigator.
  afterEach(() => {
    setNavigator(original.share, original.canShare);
    vi.restoreAllMocks();
  });

  it('reports false when the browser has no share API at all', () => {
    setNavigator(undefined, undefined);
    const file = makeExportFile('{}', 'x.json', 'application/json');
    expect(canShareFile(file)).toBe(false);
  });

  it('falls back to download when canShare returns false', async () => {
    setNavigator(vi.fn(), () => false);
    const clicks: string[] = [];
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreate(tag) as HTMLElement;
      if (tag === 'a') el.click = () => clicks.push((el as HTMLAnchorElement).download);
      return el;
    });
    // jsdom has no object-URL implementation.
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:stub', configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });

    const file = makeExportFile('{}', 'open-pilot-logbook-2026-08-06.json', 'application/json');
    const result = await deliverExport(file, 'auto');

    expect(result.ok).toBe(true);
    expect(result.route).toBe('download');
    expect(clicks).toEqual(['open-pilot-logbook-2026-08-06.json']);
  });

  it('reports cancellation when share rejects with AbortError', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    setNavigator(
      vi.fn(async () => {
        throw abort;
      }),
      () => true,
    );
    const file = makeExportFile('{}', 'x.json', 'application/json');
    const result = await deliverExport(file, 'auto');
    expect(result).toEqual({ ok: false, route: 'share', cancelled: true });
  });

  it('uses the share route when the browser supports it', async () => {
    const share = vi.fn(async () => {});
    setNavigator(share, () => true);
    const file = makeExportFile('{}', 'x.json', 'application/json');
    const result = await deliverExport(file, 'auto');
    expect(result.ok).toBe(true);
    expect(result.route).toBe('share');
    expect(share).toHaveBeenCalledOnce();
  });
});

describe('filenames', () => {
  it('uses the local date, not UTC', () => {
    // 23:30 local on the 6th is already the 7th in UTC; the filename must read
    // as the day the user pressed the button.
    const late = new Date(2026, 7, 6, 23, 30);
    expect(exportFilename('json', late)).toBe('open-pilot-logbook-2026-08-06.json');
  });

  it('zero-pads month and day', () => {
    expect(exportFilename('csv', new Date(2026, 0, 5))).toBe('open-pilot-logbook-2026-01-05.csv');
  });
});

describe('backup reminder', () => {
  const now = new Date('2026-08-06T12:00:00.000Z');

  it('is quiet just after a backup', () => {
    const status = backupStatus('2026-08-05T12:00:00.000Z', now, 10);
    expect(status.urgency).toBe('quiet');
    expect(status.daysSince).toBe(1);
  });

  it('turns gentle at 7 days and prominent at 30', () => {
    expect(backupStatus('2026-07-30T12:00:00.000Z', now, 10).urgency).toBe('gentle');
    expect(backupStatus('2026-07-07T12:00:00.000Z', now, 10).urgency).toBe('prominent');
  });

  it('has a distinct never-exported state, hidden until there is data worth losing', () => {
    expect(backupStatus(null, now, 10)).toMatchObject({ urgency: 'never', visible: true });
    expect(backupStatus(null, now, 1)).toMatchObject({ urgency: 'never', visible: false });
  });

  it('treats an unparseable stored timestamp as never backed up', () => {
    expect(backupStatus('not-a-date', now, 10).urgency).toBe('never');
  });

  it('labels the states in plain language', () => {
    expect(backupLabel(backupStatus(null, now, 10))).toBe('Never backed up');
    expect(backupLabel(backupStatus('2026-08-06T01:00:00.000Z', now, 10))).toBe('Backed up today');
    expect(backupLabel(backupStatus('2026-08-05T01:00:00.000Z', now, 10))).toBe('Backed up yesterday');
    expect(backupLabel(backupStatus('2026-07-07T12:00:00.000Z', now, 10))).toBe(
      'Last backup 30 days ago',
    );
  });
});

/**
 * The list can hide simulator entries. That is a DISPLAY preference and it must
 * stop at the list — a pilot who hides them and then backs up must still get
 * them in the file, or the backup silently omits part of their logbook.
 */
describe('simulator entries and the export', () => {
  beforeEach(async () => {
    await db.settings.clear();
  });

  async function exportedText(kind: 'json' | 'csv'): Promise<string> {
    const d = deps({ ok: true });
    await exportLogbook(kind, 'auto', d);
    return readFileText(d.deliver.mock.calls[0][0]);
  }

  it('includes the simulator session in JSON with the setting ON', async () => {
    await updateSettings({ showSimulatorEntries: true });
    const text = await exportedText('json');
    expect(text).toContain('"entryType": "fstd"');
    expect(text).toContain('EU-DK187');
  });

  it('STILL includes it in JSON with the setting OFF', async () => {
    await updateSettings({ showSimulatorEntries: false });
    const text = await exportedText('json');
    expect(text).toContain('"entryType": "fstd"');
    expect(text).toContain('EU-DK187');
  });

  it('STILL includes it in CSV with the setting OFF', async () => {
    await updateSettings({ showSimulatorEntries: false });
    const text = await exportedText('csv');
    expect(text).toContain('fstd');
    expect(text).toContain('EU-DK187');
  });

  it('produces byte-identical output either way', async () => {
    await updateSettings({ showSimulatorEntries: true });
    const shown = await exportedText('json');
    await updateSettings({ showSimulatorEntries: false });
    const hidden = await exportedText('json');
    expect(hidden).toBe(shown);
  });

  it('exports the simulator session with zero flight time', async () => {
    const parsed = JSON.parse(await exportedText('json'));
    const sim = parsed.flights.find((f: { entryType: string }) => f.entryType === 'fstd');
    expect(sim).toBeDefined();
    expect(sim.totalMinutes).toBe(0);
    expect(sim.simulatorMinutes).toBe(240);
  });
});
