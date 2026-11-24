import { recommendedRoutes, type Grade, type RouteChoice } from "../shared/dispatch";
import type { Operations } from "../shared/operations";

export const maxCandidates = 12;
export const undoWindowMs = 8000;
const sameModel = (a: RouteChoice, b: RouteChoice) => a.provider === b.provider && a.model === b.model;

// The list an edit starts from. An unsaved grade starts from the board's own candidates, so the
// first change keeps what the person was looking at.
export function editableCandidates(data: Pick<Operations, "catalog" | "routing">, grade: Grade): RouteChoice[] {
  return data.routing[grade] ?? recommendedRoutes(grade, data.catalog);
}

// A model appears once. Adding one that is already listed moves it and takes the new effort.
export function addCandidate(list: readonly RouteChoice[], route: RouteChoice, place: "first" | "last"): RouteChoice[] {
  const rest = list.filter(candidate => !sameModel(candidate, route));
  return (place === "first" ? [route, ...rest] : [...rest, route]).slice(0, maxCandidates);
}
export function canAdd(list: readonly RouteChoice[], route: RouteChoice) {
  return list.length < maxCandidates || list.some(candidate => sameModel(candidate, route));
}
export function removeCandidate(list: readonly RouteChoice[], index: number): RouteChoice[] {
  return list.filter((_, position) => position !== index);
}
// The board's own list cannot be saved empty: with its only candidate removed there is nothing to save.
export function canRemove(list: readonly RouteChoice[], saved: boolean) {
  return saved || list.length > 1;
}
export function moveUp(list: readonly RouteChoice[], index: number): RouteChoice[] {
  if (index <= 0 || index >= list.length) return [...list];
  const next = [...list];
  [next[index - 1], next[index]] = [next[index], next[index - 1]];
  return next;
}
export function moveFirst(list: readonly RouteChoice[], index: number): RouteChoice[] {
  if (index <= 0 || index >= list.length) return [...list];
  return [list[index], ...list.filter((_, position) => position !== index)];
}
export function setEffort(list: readonly RouteChoice[], index: number, effort: string | null): RouteChoice[] {
  return list.map((candidate, position) => position === index ? { ...candidate, effort } : candidate);
}
export const sameList = (a: readonly RouteChoice[], b: readonly RouteChoice[]) => JSON.stringify(a) === JSON.stringify(b);

// What each grade's row is showing about its last change. Kept per grade, so opening another
// grade never drops a change that failed to save.
export type RowEdit = {
  saving?: boolean;
  failed?: { candidates: RouteChoice[]; message: string };
  // The list saved before the last change. An empty list means the board's own recommendation.
  undo?: { previous: RouteChoice[]; until: number };
  note?: "saved" | "undone" | "conflict";
  noteUntil?: number;
};
export type RoutingEdits = Partial<Record<Grade, RowEdit>>;

export function saveStarted(edits: RoutingEdits, grade: Grade): RoutingEdits {
  return { ...edits, [grade]: { saving: true } };
}
// `previous` is null when the save was itself an undo: an undo is offered once.
export function saveSucceeded(edits: RoutingEdits, grade: Grade, previous: RouteChoice[] | null, now: number): RoutingEdits {
  const until = now + undoWindowMs;
  return { ...edits, [grade]: previous ? { note: "saved", noteUntil: until, undo: { previous, until } } : { note: "undone", noteUntil: until } };
}
export function saveFailed(edits: RoutingEdits, grade: Grade, candidates: RouteChoice[], message: string): RoutingEdits {
  return { ...edits, [grade]: { failed: { candidates, message } } };
}
// Someone else changed the routing first. The latest list is shown and the attempted change is dropped.
export function saveConflicted(edits: RoutingEdits, grade: Grade, now: number): RoutingEdits {
  return { ...edits, [grade]: { note: "conflict", noteUntil: now + undoWindowMs } };
}
export function undoTarget(edits: RoutingEdits, grade: Grade, now: number): RouteChoice[] | null {
  const undo = edits[grade]?.undo;
  return undo && !edits[grade]?.saving && now < undo.until ? undo.previous : null;
}
// Drops notes and undo offers whose time is up. A failed change stays until it is retried or dismissed.
export function expireEdits(edits: RoutingEdits, now: number): RoutingEdits {
  let changed = false;
  const next: RoutingEdits = {};
  for (const [grade, edit] of Object.entries(edits) as [Grade, RowEdit][]) {
    if (edit.noteUntil !== undefined && now >= edit.noteUntil && !edit.saving && !edit.failed) { changed = true; continue; }
    next[grade] = edit;
  }
  return changed ? next : edits;
}
export function nextExpiry(edits: RoutingEdits): number | null {
  const times = Object.values(edits).flatMap(edit => edit?.noteUntil !== undefined && !edit.saving && !edit.failed ? [edit.noteUntil] : []);
  return times.length ? Math.min(...times) : null;
}
export function dismissFailure(edits: RoutingEdits, grade: Grade): RoutingEdits {
  const { [grade]: _dropped, ...rest } = edits;
  return rest;
}
// A save that was refused while the stored revision moved on lost to another change.
export const lostToAnotherChange = (sentRevision: number, latestRevision: number | null) => latestRevision !== null && latestRevision !== sentRevision;
