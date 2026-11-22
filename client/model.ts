import type { z } from "zod";
import type { boardSnapshot, saveNote } from "../shared/contract";

export type Snapshot = z.output<typeof boardSnapshot.output>;
export type Session = Snapshot["sessions"][number];
export type Note = Snapshot["notes"][string];
export type NoteInput = z.input<typeof saveNote.input>;
export type Lane = Session["lane"] | "done";
export type Card = { session: Session; note: Note | undefined; lane: Lane };
export const lanes: readonly Lane[] = ["human", "running", "review", "idle", "done", "unknown"];
export const labels: Record<Lane, string> = {
  human: "내 결정", running: "진행 중", review: "확인 대기", idle: "대기 중", done: "완료", unknown: "미확인",
};
export const noteLabels = { question: "결정 요청", review: "확인 요청", done: "완료 근거" } as const;

function displayLane(session: Session, note: Note | undefined): Lane {
  if (session.evidenceId && session.evidenceId === note?.evidenceId && note.origin === "person") {
    if (note.kind === "done") return "done";
    if (note.kind === "review") return "review";
    if (note.kind === "clear" && session.lane === "human") return "idle";
  }
  if (session.lane === "human" || note?.kind === "question") return "human";
  if (session.lane === "running") return "running";
  if (session.lane === "review" || note?.kind === "review" || (note?.kind === "done" && note.origin === "agent")) return "review";
  if (note?.kind === "done") return "done";
  return session.lane;
}

export function projectCards(snapshot: Snapshot) {
  const projects = new Map<string, { id: string; title: string; cards: Card[] }>();
  const human: Card[] = [];
  for (const session of snapshot.sessions) {
    const note = snapshot.notes[session.id];
    const card = { session, note, lane: displayLane(session, note) };
    const project = projects.get(session.projectId) ?? { id: session.projectId, title: session.projectTitle, cards: [] };
    project.cards.push(card);
    projects.set(project.id, project);
    if (card.lane === "human") human.push(card);
  }
  return { human, projects: [...projects.values()].sort((a, b) => a.title.localeCompare(b.title)) };
}
