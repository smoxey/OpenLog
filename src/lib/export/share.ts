/**
 * Delivery — the ONLY module in the export path that touches browser APIs.
 * Everything upstream of it is a pure serializer.
 *
 * Two routes:
 *  - Web Share API where `navigator.canShare({ files })` allows it. This is the
 *    iOS backup path and the main reason Phase 3a exists: it puts the file
 *    straight into Mail, Files or AirDrop, which is how a phone-only user gets
 *    a logbook off their device.
 *  - A Blob download everywhere else, also reachable deliberately — some users
 *    want the file on disk even where sharing works.
 *
 * Feature-detected, never user-agent sniffed: `canShare({ files })` is the only
 * honest test of whether file sharing will actually work.
 */

export type DeliveryMode = 'auto' | 'share' | 'download';

export interface DeliveryResult {
  /** True only when the file was actually delivered. Drives `lastBackupAt`. */
  ok: boolean;
  route: 'share' | 'download';
  /** The user dismissed the share sheet. Not a backup, not an error. */
  cancelled: boolean;
  error?: string;
}

/** Does this browser support sharing THIS file? Files support varies by type. */
export function canShareFile(file: File): boolean {
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  try {
    return nav.canShare({ files: [file] });
  } catch {
    // Some engines throw rather than returning false for unsupported payloads.
    return false;
  }
}

export function makeExportFile(contents: string, filename: string, mime: string): File {
  return new File([contents], filename, { type: mime });
}

/**
 * Download via an object URL.
 *
 * The URL is revoked after the click. Revocation is deferred by a tick because
 * some browsers abort an in-flight download if the URL dies in the same task.
 */
function downloadFile(file: File): DeliveryResult {
  const url = URL.createObjectURL(file);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return { ok: true, route: 'download', cancelled: false };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Deliver an export.
 *
 * `mode: 'auto'` shares when possible and downloads otherwise; 'share' and
 * 'download' force a route so both stay reachable on purpose.
 *
 * BACKUP ACCOUNTING: a share sheet the user cancels is NOT a backup, and
 * `navigator.share()` rejects with `AbortError` in that case — that rejection
 * is how `ok: false` gets set. Some platforms, however, resolve the promise
 * without telling us whether the user completed the share or merely closed the
 * sheet after picking nothing. Where the platform will not say, we record the
 * backup on the promise resolving, which can over-count. Over-counting a backup
 * is the safer failure than nagging someone who just filed one — and the
 * indicator is advisory, not a data guarantee.
 */
export async function deliverExport(file: File, mode: DeliveryMode): Promise<DeliveryResult> {
  const wantsShare = mode === 'share' || (mode === 'auto' && canShareFile(file));

  if (wantsShare) {
    if (!canShareFile(file)) {
      if (mode === 'share') {
        return {
          ok: false,
          route: 'share',
          cancelled: false,
          error: 'Sharing files is not supported in this browser.',
        };
      }
    } else {
      try {
        await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({
          files: [file],
          title: file.name,
        });
        return { ok: true, route: 'share', cancelled: false };
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name === 'AbortError') {
          return { ok: false, route: 'share', cancelled: true };
        }
        // A real failure (permission, payload too large). Fall through to the
        // download route rather than leaving the user with nothing.
        if (mode === 'share') {
          return {
            ok: false,
            route: 'share',
            cancelled: false,
            error: error instanceof Error ? error.message : 'Sharing failed.',
          };
        }
      }
    }
  }

  return downloadFile(file);
}
