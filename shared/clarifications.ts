import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { SessionRow, Note } from "./contract";
import type { TrackedDecisionView } from "./tracked-decisions";
import { repositorySlug, type PullRequestView } from "./prs";
import { matchesWorkspace } from "./workspace-pull";
import { workImages } from "./work-images";

const id = z.string().min(1).max(256);
const project = z.string().min(1).max(4096);
export const clarificationCard = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("tracked"),
    source: id,
    projectId: project.nullable(),
    id,
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("session"),
    projectId: project,
    sessionId: id,
    version: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal("pull"),
    projectId: project,
    repo: repositorySlug,
    number: z.number().int().positive(),
    updatedAt: z.string().min(1).max(64),
  }),
]);
export type ClarificationCard = z.infer<typeof clarificationCard>;
export const clarificationEntry = z.object({
  cardKey: z.string(),
  messageId: z.string().uuid(),
  recipientId: id,
  question: z.string(),
  at: z.string().datetime(),
  status: z.enum(["pending", "sent"]),
  response: z.string().optional(),
  imageCount: z.number().int().positive().optional(),
});
export type ClarificationEntry = z.infer<typeof clarificationEntry>;
export const askClarification = defineRpc({
  name: "board.ask-clarification",
  input: z
    .strictObject({
      card: clarificationCard,
      recipientId: id,
      question: z.string().max(4000),
      requestKey: z
        .string()
        .min(12)
        .max(96)
        .regex(/^[a-zA-Z0-9_-]+$/),
      images: workImages.optional(),
    })
    .refine((x) => !!x.question.trim() || !!x.images?.length),
  output: z.object({ ok: z.literal(true), messageId: z.string().uuid(), recipientId: id }),
});
export type ClarificationInput = z.input<typeof askClarification.input>;
export function clarificationKey(card: ClarificationCard) {
  switch (card.kind) {
    case "tracked":
      return JSON.stringify([card.kind, card.source, card.projectId, card.id, card.fingerprint]);
    case "session":
      return JSON.stringify([card.kind, card.projectId, card.sessionId, card.version]);
    case "pull":
      return JSON.stringify([card.kind, card.projectId, card.repo, card.number, card.updatedAt]);
  }
}
export function sessionClarificationCard(row: SessionRow, note?: Note): ClarificationCard | null {
  if (row.decisionAnswered || (row.nativePending && !row.permissionVersion)) return null;
  const version = row.decision?.version || (note?.kind === "question" ? "note:" + note.revision : null);
  return version ? { kind: "session", projectId: row.projectId, sessionId: row.id, version } : null;
}
export type ClarificationView = {
  sessions: SessionRow[];
  notes?: Record<string, Note>;
  coordinator: string | null;
  trackedDecisions?: TrackedDecisionView;
  pullRequests?: PullRequestView;
};
export function clarificationTarget(card: ClarificationCard, view: ClarificationView) {
  const session = (id: string | null | undefined) =>
    view.sessions.find((s) => s.id === id && s.projectId === card.projectId);
  function target(row: SessionRow | undefined) {
    return row && !row.nativePending && row.status === "idle" && row.lane !== "running"
      ? row.id
      : view.coordinator;
  }
  if (card.kind === "session") {
    const row = session(card.sessionId);
    const note = view.notes?.[card.sessionId];
    const ref = row && sessionClarificationCard(row, note);
    if (!row || !ref || clarificationKey(ref) !== clarificationKey(card)) return null;
    const recipientId = target(row);
    if (row.nativePending && recipientId === row.id) return null;
    return {
      recipientId,
      sourceSessionId: row.id,
      sourceHost: null,
      title: row.title,
      question: row.decision?.question ?? note!.text,
    };
  }
  if (card.kind === "tracked") {
    const item = view.trackedDecisions?.items.find(
      (r) =>
        r.source === card.source &&
        r.projectId === card.projectId &&
        r.id === card.id &&
        r.fingerprint === card.fingerprint,
    );
    if (!item) return null;
    const sourceSessionId = item.sessionId || item.matchedSessionId;
    const row = item.sessionHost ? undefined : session(sourceSessionId);
    const parts = item.questions.map((q) => [q.id, q.text].filter(Boolean).join(" · "));
    return {
      recipientId: target(row),
      sourceSessionId,
      sourceHost: item.sessionHost ?? null,
      title: item.title,
      question: ([...new Set([...item.ask, ...parts])].join("\n") || item.title).slice(0, 16000),
    };
  }
  const pr = view.pullRequests?.items.find(
    (p) =>
      p.repo === card.repo &&
      p.number === card.number &&
      p.updatedAt === card.updatedAt &&
      p.projectIds.includes(card.projectId) &&
      p.lane === "review",
  );
  if (!pr) return null;
  const owners = view.sessions.filter(
    (s) => s.projectId === card.projectId && matchesWorkspace(pr, s.workspacePull),
  );
  const owner = owners.length === 1 ? owners[0] : undefined;
  return {
    recipientId: target(owner),
    sourceSessionId: owner?.id ?? null,
    sourceHost: null,
    title: pr.title,
    question: pr.url,
  };
}
export const clarificationRecipient = (card: ClarificationCard, view: ClarificationView) =>
  clarificationTarget(card, view)?.recipientId ?? null;
