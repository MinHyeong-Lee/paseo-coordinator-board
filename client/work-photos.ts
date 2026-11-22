/// <reference lib="dom" />
import {
  MAX_WORK_IMAGE_BYTES, MAX_WORK_IMAGES, MAX_WORK_IMAGES_BYTES, WORK_IMAGE_MIME_TYPES, type WorkImage,
} from "../shared/operations";

export type DraftPhoto = { id: number; name: string; size: number; image: WorkImage; preview: string; questionIndex?: number };
export type PhotoError = "format" | "count" | "size" | "total" | "read";

function photoType(file: Pick<File, "type" | "name">): WorkImage["mimeType"] | undefined {
  const suffix = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = file.type || ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[suffix]);
  return WORK_IMAGE_MIME_TYPES.find(allowed => allowed === type);
}

export function checkPhotoSelection(existing: readonly Pick<DraftPhoto, "size">[], files: readonly Pick<File, "type" | "name" | "size">[]): PhotoError | null {
  if (existing.length + files.length > MAX_WORK_IMAGES) return "count";
  if (files.some(file => !photoType(file))) return "format";
  if (files.some(file => !file.size || file.size > MAX_WORK_IMAGE_BYTES)) return "size";
  const total = [...existing, ...files].reduce((sum, file) => sum + file.size, 0);
  return total > MAX_WORK_IMAGES_BYTES ? "total" : null;
}

export async function readWorkPhoto(file: File): Promise<WorkImage> {
  const mimeType = photoType(file);
  if (!mimeType) throw Error("format");
  const encoded = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result;
      if (typeof url !== "string" || !url.includes(";base64,")) reject(Error("read"));
      else resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onabort = reader.onerror = () => reject(Error("read"));
    reader.readAsDataURL(file);
  });
  return { mimeType, data: encoded };
}

export function clipboardPhotos(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  if (files.length) return files;
  return Array.from(data.items).flatMap(item => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

export function isFileDrag(data: DataTransfer): boolean {
  // Browsers hide the FileList until drop, but expose the drag's type during dragover.
  return Array.from(data.types).includes("Files") || data.files.length > 0 || Array.from(data.items).some(item => item.kind === "file");
}
