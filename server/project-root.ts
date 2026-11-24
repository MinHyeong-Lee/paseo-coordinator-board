import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

// The host filesystem decides whether case variants and symlinks refer to the same directory.
export async function projectRootKey(path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return;
  try {
    const info = await stat(path, { bigint: true });
    if (info.isDirectory() && info.ino !== 0n) return `${info.dev}:${info.ino}`;
  } catch {
    // An inaccessible root has no verified identity to share with another project.
  }
}
