import type { Card } from "./model";
import type { MergeNotification, PullRequestItem } from "../shared/prs";
import type { TrackedDecision } from "../shared/tracked-decisions";

export const pullRowKey = (pr: Pick<PullRequestItem, "repo" | "number">) => JSON.stringify(["pull", pr.repo, pr.number]);
export const recordRowKey = (item: TrackedDecision) => JSON.stringify(["record", item.key, item.fingerprint]);
export const sessionRowKey = (card: Card) => JSON.stringify(["session", card.session.projectId, card.session.id, card.session.decision?.version]);

export type CompletedAction = {
  actionKey: string;
  rowKey: string;
  projectIds: (string | null)[];
  status: "merged" | "already-merged" | "sent" | "saved" | "reviewed" | "already-closed";
  title: string;
  detail?: string;
  mergeProjectId?: string;
  notification?: MergeNotification;
};
export type InlineReceipt = CompletedAction & { order: readonly string[]; hidden?: boolean };

// Reinsert removed rows beside the same neighbors, even when two actions finish out of order.
// A revision is part of the row key, so a new question can coexist with its earlier receipt.
export function withReceiptPositions(active: readonly string[], receipts: readonly InlineReceipt[]) {
  const rows = [...active];
  for (const { rowKey, order, hidden } of receipts) {
    if (hidden || rows.includes(rowKey)) continue;
    const index = order.indexOf(rowKey);
    const next = order.slice(index + 1).find(key => rows.includes(key));
    const previous = order.slice(0, Math.max(0, index)).reverse().find(key => rows.includes(key));
    const position = next !== undefined ? rows.indexOf(next)
      : previous !== undefined ? rows.indexOf(previous) + 1
      : Math.min(Math.max(0, index), rows.length);
    rows.splice(position, 0, rowKey);
  }
  return rows;
}
