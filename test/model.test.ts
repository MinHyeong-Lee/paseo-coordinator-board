import { expect, test } from "bun:test";
import { projectCards } from "../client/model";
import type { Note, SessionRow } from "../shared/contract";

test("the digest and projects share one classification; new work takes priority over past completion", () => {
  const base: SessionRow = {
    id: "", title: "검토", projectId: "alpha", projectTitle: "서점", workspaceTitle: "작업",
    model: null, lane: "idle", detail: "",
  };
  const statuses = ["human", "running", "review", "idle", "idle", "idle"] as const;
  const sessions = statuses.map((lane, index) => ({
    ...base, lane, id: String(index), projectId: index < 3 ? "alpha" : "beta",
  }));
  const notes = Object.fromEntries(sessions.slice(0, 5).map((session, i) => [session.id, {
    sessionId: session.id, kind: i === 4 ? "question" : "done", text: "예시 근거", revision: 1,
  } satisfies Note]));
  const { human, projects } = projectCards({ sessions, notes, projects: [], coordinator: null });
  expect(human.map(c => c.session.id)).toEqual(["0", "4"]);
  expect(projects.flatMap(p => p.cards).map(c => c.lane)).toEqual(["human", "running", "review", "done", "human", "idle"]);
  expect(projects.length).toBe(2);
});

test("a delivered reply takes the same question out of the digest while preserving live work and new prompts", () => {
  const sessions: SessionRow[] = (["idle", "running", "unknown", "human"] as const).map((lane, i) => ({
    id: String(i), title: "Review", projectId: "p", projectTitle: "P", workspaceTitle: "W",
    lane, detail: "", model: null, decisionAnswered: true, nativePending: i === 3,
  }));
  const notes = Object.fromEntries(sessions.map(s => [s.id, { sessionId: s.id, kind: "question", text: "original", revision: 1 } satisfies Note]));
  const { projects, human } = projectCards({ sessions, notes, projects: [], coordinator: null });
  expect(projects[0].cards.map(c => c.lane)).toEqual(["review", "running", "unknown", "human"]);
  expect(human.map(c => c.session.id)).toEqual(["3"]);
});
