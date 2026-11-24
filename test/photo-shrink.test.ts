import { expect, test } from "bun:test";
import {
  photoBudgets, photoShrinkSupported, shrinkAttempts, shrinkSummary, shrinkWith, type ShrinkAttempt,
} from "../client/photo-shrink";
import { prepareWorkPhotos, type PhotoShrinker } from "../client/work-photos";
import { MAX_WORK_IMAGE_BYTES, MAX_WORK_IMAGES_BYTES } from "../shared/operations";

const MiB = 1024 * 1024;

// A stand-in encoder: bytes grow with pixels and quality, PNG costs more per pixel than lossy formats.
function fakeEncoder(bytesPerPixel: Partial<Record<ShrinkAttempt["mimeType"], number>>, log: ShrinkAttempt[] = []) {
  return async (attempt: ShrinkAttempt) => {
    log.push(attempt);
    const rate = bytesPerPixel[attempt.mimeType];
    if (rate === undefined) return new Blob(["x"], {type: "image/png"}); // browser without this encoder falls back to PNG
    const size = Math.round(attempt.width * attempt.height * rate * (attempt.quality ?? 1));
    return new Blob([new Uint8Array(size)], {type: attempt.mimeType});
  };
}

test("attempts shrink the long edge step by step and keep the aspect ratio", () => {
  const attempts = shrinkAttempts("image/jpeg", 4032, 3024);
  expect(attempts[0]).toEqual({mimeType: "image/jpeg", width: 2560, height: 1920, quality: 0.85});
  expect(attempts.map(a => Math.max(a.width, a.height))).toEqual([2560, 2048, 1600, 1600, 1280, 1024]);
  expect(attempts.every(a => a.mimeType === "image/jpeg")).toBe(true);
  expect(attempts.map(a => a.quality)).toEqual([0.85, 0.85, 0.85, 0.75, 0.75, 0.65]);
  const portrait = shrinkAttempts("image/webp", 3000, 6000)[0];
  expect(portrait).toEqual({mimeType: "image/webp", width: 1280, height: 2560, quality: 0.85});
});

test("PNG screenshots shrink losslessly first and only then switch to WebP", () => {
  const attempts = shrinkAttempts("image/png", 5120, 2880);
  const firstWebp = attempts.findIndex(a => a.mimeType === "image/webp");
  expect(attempts.slice(0, firstWebp).map(a => [a.mimeType, a.width])).toEqual([["image/png", 2560], ["image/png", 2048]]);
  expect(attempts.slice(0, firstWebp).every(a => a.quality === undefined)).toBe(true);
  expect(attempts.slice(firstWebp).every(a => a.mimeType === "image/webp")).toBe(true);
});

test("a small image that is still too many bytes is re-encoded at its own size without upscaling", () => {
  const attempts = shrinkAttempts("image/jpeg", 1800, 1200);
  expect(attempts[0]).toEqual({mimeType: "image/jpeg", width: 1800, height: 1200, quality: 0.85});
  expect(attempts.every(a => a.width <= 1800 && a.height <= 1200)).toBe(true);
  expect(new Set(attempts.map(a => `${a.mimeType}:${a.width}:${a.quality}`)).size).toBe(attempts.length);
});

test("a large JPEG shrinks to the first step that fits the target", async () => {
  const log: ShrinkAttempt[] = [];
  const source = {mimeType: "image/jpeg" as const, width: 4032, height: 3024, size: 8.4e6};
  // 2560x1920 at 0.85 is about 4.2 MB, so the first attempt already fits 5 MiB.
  const result = await shrinkWith(source, MAX_WORK_IMAGE_BYTES, fakeEncoder({"image/jpeg": 1}, log));
  expect(result?.attempt).toEqual({mimeType: "image/jpeg", width: 2560, height: 1920, quality: 0.85});
  expect(result!.blob.size).toBeLessThanOrEqual(MAX_WORK_IMAGE_BYTES);
  expect(log).toHaveLength(1);
});

test("a large PNG keeps PNG when the smaller size fits and moves to WebP when it does not", async () => {
  const source = {mimeType: "image/png" as const, width: 5120, height: 2880, size: 14e6};
  const lossless = await shrinkWith(source, MAX_WORK_IMAGE_BYTES, fakeEncoder({"image/png": 0.9, "image/webp": 0.3}));
  expect(lossless?.attempt.mimeType).toBe("image/png");
  expect(lossless!.blob.size).toBeLessThanOrEqual(MAX_WORK_IMAGE_BYTES);
  const lossy = await shrinkWith(source, MAX_WORK_IMAGE_BYTES, fakeEncoder({"image/png": 3, "image/webp": 0.3}));
  expect(lossy?.attempt.mimeType).toBe("image/webp");
  expect(lossy!.blob.size).toBeLessThanOrEqual(MAX_WORK_IMAGE_BYTES);
});

test("an encoder that silently returns another format is skipped", async () => {
  const source = {mimeType: "image/png" as const, width: 5120, height: 2880, size: 14e6};
  // Safari-like: no WebP encoder, so asking for WebP returns PNG.
  expect(await shrinkWith(source, MAX_WORK_IMAGE_BYTES, fakeEncoder({"image/png": 3}))).toBeNull();
});

test("a result that would be larger than the original is never chosen", async () => {
  const source = {mimeType: "image/jpeg" as const, width: 2000, height: 1500, size: 1e6};
  expect(await shrinkWith(source, 2 * MiB, fakeEncoder({"image/jpeg": 2}))).toBeNull();
});

test("an image that cannot reach the target returns no result", async () => {
  const source = {mimeType: "image/jpeg" as const, width: 4032, height: 3024, size: 9e6};
  expect(await shrinkWith(source, 10_000, fakeEncoder({"image/jpeg": 1}))).toBeNull();
});

test("budgets keep photos that fit and shrink the largest photos first to fit the total", () => {
  expect(photoBudgets(0, [1 * MiB, 2 * MiB])).toEqual([1 * MiB, 2 * MiB]);
  expect(photoBudgets(0, [8 * MiB])).toEqual([MAX_WORK_IMAGE_BYTES]);
  const sizes = [1 * MiB, 4.5 * MiB, 4.8 * MiB, 4.9 * MiB];
  const budgets = photoBudgets(0, sizes)!;
  expect(budgets[0]).toBe(1 * MiB);
  expect(budgets.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_WORK_IMAGES_BYTES);
  expect(budgets.slice(1).every(budget => budget < 4.5 * MiB)).toBe(true);
  const withExisting = photoBudgets(10 * MiB, [3 * MiB])!;
  expect(withExisting[0]).toBeLessThanOrEqual(2 * MiB);
  expect(photoBudgets(MAX_WORK_IMAGES_BYTES, [1 * MiB])).toBeNull();
});

test("shrinking runs only on web with an image decoder and a document", () => {
  const browser = {createImageBitmap: () => {}, document: {createElement: () => {}}} as unknown as typeof globalThis;
  expect(photoShrinkSupported("web", browser)).toBe(true);
  expect(photoShrinkSupported("ios", browser)).toBe(false);
  expect(photoShrinkSupported("android", browser)).toBe(false);
  expect(photoShrinkSupported("web", {document: {createElement: () => {}}} as unknown as typeof globalThis)).toBe(false);
  expect(photoShrinkSupported("web", {createImageBitmap: () => {}} as unknown as typeof globalThis)).toBe(false);
});

test("the preview summary shows bytes and pixels before and after", () => {
  expect(shrinkSummary({fromBytes: 8_400_000, toBytes: 3_100_000, fromWidth: 4032, fromHeight: 3024, toWidth: 2048, toHeight: 1536}))
    .toEqual({bytes: "8.4 MB → 3.1 MB", pixels: "4032×3024 → 2048×1536"});
  expect(shrinkSummary({fromBytes: 1_200_000, toBytes: 640_000, fromWidth: 2000, fromHeight: 1000, toWidth: 2000, toHeight: 1000}))
    .toEqual({bytes: "1.2 MB → 640 KB", pixels: "2000×1000"});
});

function withReader<T>(run: () => Promise<T>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  class Reader {
    result = "";
    onload = () => {};
    onerror = () => {};
    readAsDataURL(blob: Blob) {
      void blob.arrayBuffer().then(buffer => {
        this.result = `data:${blob.type};base64,` + Buffer.from(buffer).toString("base64");
        this.onload();
      });
    }
  }
  Object.defineProperty(globalThis, "FileReader", {value: Reader, configurable: true});
  return run().finally(() => {
    if (original) Object.defineProperty(globalThis, "FileReader", original); else Reflect.deleteProperty(globalThis, "FileReader");
  });
}

const photo = (name: string, size: number, type = "image/jpeg") => new File([new Uint8Array(size)], name, {type});

test("photos within the limits are attached unchanged without calling the shrinker", async () => {
  let calls = 0;
  const shrinker: PhotoShrinker = async () => { calls++; return null; };
  const result = await withReader(() => prepareWorkPhotos([], [photo("a.jpg", 1000)], shrinker));
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) return;
  expect(result[0]).toMatchObject({name: "a.jpg", size: 1000, image: {mimeType: "image/jpeg"}});
  expect(result[0]!.shrunk).toBeUndefined();
  expect(calls).toBe(0);
});

test("an oversized photo is replaced by the shrunk copy and records what changed", async () => {
  const targets: number[] = [];
  const shrinker: PhotoShrinker = async (_file, _type, target) => {
    targets.push(target);
    return {blob: new Blob([new Uint8Array(2000)], {type: "image/webp"}), fromWidth: 5000, fromHeight: 2500, toWidth: 2560, toHeight: 1280};
  };
  const big = photo("shot.png", MAX_WORK_IMAGE_BYTES + 1, "image/png");
  const result = await withReader(() => prepareWorkPhotos([], [big], shrinker));
  if (!Array.isArray(result)) throw Error(String(result));
  expect(targets).toEqual([MAX_WORK_IMAGE_BYTES]);
  expect(result[0]).toMatchObject({name: "shot.png", size: 2000, image: {mimeType: "image/webp"},
    shrunk: {fromBytes: MAX_WORK_IMAGE_BYTES + 1, toBytes: 2000, fromWidth: 5000, toWidth: 2560}});
  expect(Buffer.from(result[0]!.image.data, "base64").length).toBe(2000);
});

test("the batch shrinks photos that would push the total over the limit", async () => {
  const targets: number[] = [];
  const shrinker: PhotoShrinker = async (file, type, target) => {
    targets.push(target);
    return {blob: new Blob([new Uint8Array(Math.floor(target / 2))], {type}), fromWidth: 4000, fromHeight: 3000, toWidth: 2560, toHeight: 1920};
  };
  const files = [photo("1.jpg", 4.9 * MiB), photo("2.jpg", 4.9 * MiB), photo("3.jpg", 4.9 * MiB)];
  const result = await withReader(() => prepareWorkPhotos([], files, shrinker));
  if (!Array.isArray(result)) throw Error(String(result));
  expect(targets).toHaveLength(3);
  expect(result.reduce((sum, item) => sum + item.size, 0)).toBeLessThanOrEqual(MAX_WORK_IMAGES_BYTES);
});

test("a photo that cannot be shrunk enough fails the whole batch", async () => {
  const shrinker: PhotoShrinker = async () => null;
  expect(await withReader(() => prepareWorkPhotos([], [photo("a.jpg", 10), photo("b.jpg", 6 * MiB)], shrinker))).toBe("shrink");
});

test("without a shrinker the original size errors remain", async () => {
  expect(await prepareWorkPhotos([], [photo("big.jpg", MAX_WORK_IMAGE_BYTES + 1)])).toBe("size");
  expect(await prepareWorkPhotos([{size: 5 * MiB}, {size: 5 * MiB}], [photo("c.jpg", 3 * MiB)])).toBe("total");
  expect(await prepareWorkPhotos([], [photo("empty.jpg", 0)], async () => null)).toBe("size");
  expect(await prepareWorkPhotos([], [], async () => null)).toBe("read");
});
