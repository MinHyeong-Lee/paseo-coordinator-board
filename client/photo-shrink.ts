/// <reference lib="dom" />
import { MAX_WORK_IMAGE_BYTES, MAX_WORK_IMAGES_BYTES, type WorkImage } from "../shared/operations";

type PhotoType = WorkImage["mimeType"];
export type ShrinkAttempt = { mimeType: PhotoType; width: number; height: number; quality?: number };
export type ShrinkSource = { mimeType: PhotoType; width: number; height: number; size: number };
export type ShrinkNote = { fromBytes: number; toBytes: number; fromWidth: number; fromHeight: number; toWidth: number; toHeight: number };
export type ShrunkPhoto = { blob: Blob; fromWidth: number; fromHeight: number; toWidth: number; toHeight: number };

// Long edge first, then quality. Photos keep their own lossy format.
const LOSSY_STEPS: readonly [edge: number, quality: number][] = [[2560, 0.85], [2048, 0.85], [1600, 0.85], [1600, 0.75], [1280, 0.75], [1024, 0.65]];
// Screenshots stay lossless while only the size shrinks, so text stays sharp. WebP comes after that.
const PNG_EDGES = [2560, 2048];
const PNG_FALLBACK_STEPS: readonly [edge: number, quality: number][] = [[2560, 0.9], ...LOSSY_STEPS.slice(1)];
// Below this a photo is not worth encoding; the batch already uses most of the total.
const MIN_PHOTO_BUDGET = 64 * 1024;

function fit(width: number, height: number, edge: number) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function shrinkAttempts(mimeType: PhotoType, width: number, height: number): ShrinkAttempt[] {
  const plan: ShrinkAttempt[] = mimeType === "image/png"
    ? [...PNG_EDGES.map(edge => ({ mimeType, ...fit(width, height, edge) })),
      ...PNG_FALLBACK_STEPS.map(([edge, quality]) => ({ mimeType: "image/webp" as const, ...fit(width, height, edge), quality }))]
    : LOSSY_STEPS.map(([edge, quality]) => ({ mimeType, ...fit(width, height, edge), quality }));
  const seen = new Set<string>();
  return plan.filter(attempt => {
    const key = `${attempt.mimeType}:${attempt.width}x${attempt.height}:${attempt.quality ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Returns the first encoding that fits the target and is smaller than the original. */
export async function shrinkWith(source: ShrinkSource, targetBytes: number,
  encode: (attempt: ShrinkAttempt) => Promise<Blob | null>): Promise<{ blob: Blob; attempt: ShrinkAttempt } | null> {
  for (const attempt of shrinkAttempts(source.mimeType, source.width, source.height)) {
    const blob = await encode(attempt);
    // Browsers without an encoder for the requested type return PNG instead.
    if (!blob || blob.type !== attempt.mimeType) continue;
    if (blob.size > 0 && blob.size <= targetBytes && blob.size < source.size) return { blob, attempt };
  }
  return null;
}

/**
 * Byte budget for each new photo. Photos that already fit keep their size; when the batch would pass the
 * total, the largest photos share what is left equally. Returns null when nothing useful is left.
 */
export function photoBudgets(existingBytes: number, sizes: readonly number[]): number[] | null {
  const capped = sizes.map(size => Math.min(size, MAX_WORK_IMAGE_BYTES));
  let rest = MAX_WORK_IMAGES_BYTES - existingBytes;
  if (capped.reduce((sum, size) => sum + size, 0) <= rest) return capped;
  const ascending = [...capped].sort((a, b) => a - b);
  let cap = 0;
  for (const [index, size] of ascending.entries()) {
    const share = rest / (ascending.length - index);
    if (size <= share) { rest -= size; continue; }
    cap = Math.floor(share);
    break;
  }
  return cap < MIN_PHOTO_BUDGET ? null : capped.map(size => Math.min(size, cap));
}

function formatBytes(bytes: number) {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

export function shrinkSummary(note: ShrinkNote) {
  const from = `${note.fromWidth}×${note.fromHeight}`;
  const to = `${note.toWidth}×${note.toHeight}`;
  return { bytes: `${formatBytes(note.fromBytes)} → ${formatBytes(note.toBytes)}`, pixels: from === to ? from : `${from} → ${to}` };
}

type ShrinkScope = { createImageBitmap?: unknown; document?: { createElement?: unknown } };

/** The board composer only shrinks on web, where the canvas encoder exists. The mobile app sends photos from the session. */
export function photoShrinkSupported(os: string, scope: ShrinkScope = globalThis as ShrinkScope): boolean {
  return os === "web" && typeof scope.createImageBitmap === "function" && typeof scope.document?.createElement === "function";
}

/** Browser only: call after photoShrinkSupported. Re-encoding drops EXIF data, including location. */
export async function shrinkInBrowser(file: Blob, mimeType: PhotoType, targetBytes: number): Promise<ShrunkPhoto | null> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { return null; }
  const canvas = document.createElement("canvas");
  try {
    const context = canvas.getContext("2d");
    if (!context) return null;
    const result = await shrinkWith({ mimeType, width: bitmap.width, height: bitmap.height, size: file.size }, targetBytes, attempt => {
      canvas.width = attempt.width;
      canvas.height = attempt.height;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.clearRect(0, 0, attempt.width, attempt.height);
      context.drawImage(bitmap, 0, 0, attempt.width, attempt.height);
      return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, attempt.mimeType, attempt.quality));
    });
    return result && { blob: result.blob, fromWidth: bitmap.width, fromHeight: bitmap.height,
      toWidth: result.attempt.width, toHeight: result.attempt.height };
  } catch {
    return null;
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}
