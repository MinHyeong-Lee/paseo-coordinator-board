import { recordReport } from "../server/reporting";
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteStore } from "../server/notes";
import { saveNote } from "../shared/contract";

test("notes survive reopening, stale writes and stale restores are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-notes-"));
  try {
    const path = join(root, "notes.json");
    const store = new NoteStore(path);
    const a = { sessionId: "sample-1", kind: "question" as const, text: "어느 제목을 쓸까요?", expectedRevision: 0 };
    expect(store.visible(new Set([a.sessionId]))).toEqual({});
    expect(store.update(a).ok).toBe(true);
    expect(new NoteStore(path).visible(new Set([a.sessionId]))[a.sessionId].text).toBe(a.text);
    expect(store.visible(new Set(["another"]))).toEqual({});
    expect(store.update({ ...a, text: "stale" }).conflict).toBe(true);
    expect(store.update({ ...a, kind: "clear", text: "", expectedRevision: 1 }).ok).toBe(true);
    expect(store.update(a).conflict).toBe(true);
    expect(store.visible(new Set([a.sessionId]))[a.sessionId].revision).toBe(2);
    writeFileSync(path, "bad sample");
    expect(() => store.update(a)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("nonempty question or receipt is required, clear has no message", () => {
  const empty = {sessionId:"sample", kind:"done", text:"   ", expectedRevision:0};
  expect(saveNote.input.safeParse(empty).success).toBe(false);
  expect(saveNote.input.safeParse({...empty,kind:"clear"}).success).toBe(true);
});


test("agent reports are scoped to their card and preserve a person's decision or evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-report-"));
  try {
    const store = new NoteStore(join(root, "notes.json"));
    const report = {kind: "question" as const, text: "Which release?"};
    expect(recordReport(store, "a", report).isError).not.toBe(true);
    expect(store.visible(new Set(["a"])).a.origin).toBe("agent");
    expect(recordReport(store, "a", report).isError).not.toBe(true);
    expect(store.visible(new Set(["a"])).a.revision).toBe(1);
    expect(store.update({sessionId:"a",kind:"done",text:"Verified build",expectedRevision:1}).ok).toBe(true);
    expect(recordReport(store, "a", report).isError).toBe(true);
    expect(store.visible(new Set(["a"])).a.text).toBe("Verified build");
    expect(store.visible(new Set(["b"]))).toEqual({});
  } finally {
    rmSync(root, {recursive:true,force:true});
  }
});
