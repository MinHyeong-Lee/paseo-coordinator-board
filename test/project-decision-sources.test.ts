import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readProjectDecisionSources } from "../server/project-decision-sources";
import { TrackedDecisionStore } from "../server/tracked-decisions";
import { trackedDecisionViewSchema } from "../shared/tracked-decisions";

test("project ledgers retain manual checks, compound questions, and scoped exact matches", () => {
  const directory = mkdtempSync(join(tmpdir(),"board-source-"));
  const manifest = join(directory,"sources.json");
  const selected = new Set(["studio","editor"]);
  const binding = {id:"a",title:"Check playback",ask:["Listen once"],projectId:"editor",sessionId:"s",question:"Which take?"};
  const source = {source:"production",projectId:"studio",projectTitle:"Studio",repository:"studio/app",directory,matches:[binding]};
  writeFileSync(manifest, JSON.stringify({version:1,sources:[source,{...source,projectId:"other",directory:join(directory,"missing")}]}));
  const first = {since:"2025-11-01",id:"a",title:binding.title,ask:binding.ask[0],kind:"human",agentId:"s",pr:1};
  const second = {id:"b",title:"Review publication",kind:"merge",pr:2,blocksWork:true,dueAt:"2026-11-23",questions:[{text:"Pick one",options:[{key:"A",text:"Tomorrow"}]}]};
  writeFileSync(join(directory,"decisions.json"),JSON.stringify({items:[first,second]}));
  mkdirSync(join(directory,"live"));
  writeFileSync(join(directory,"live","board-answers.tsv"),"at\titemId\ttext\tattachments\tsaid\n2026-01-01\ta\tUse take 2\t0\tshort\n");
  const [a,b]=readProjectDecisionSources(manifest,selected).items;
  expect(a.sessionMatch?.question).toBe("Which take?");
  expect(a.mergeTarget).toBeUndefined();
  expect(a.replyHistory[0].text).toBe("Use take 2");
  expect(b.mergeTarget).toEqual({repo:"studio/app",number:2});
  expect(b).toMatchObject({blocksWork:true,dueAt:"2026-11-23"});
  expect(b.questions[0].options[0].text).toBe("Tomorrow");
  expect(readProjectDecisionSources(manifest,new Set(["studio"])).items[0].sessionMatch).toBeUndefined();
  writeFileSync(join(directory,"decisions.json"),JSON.stringify({items:[{...first,ask:"Check the other take"}]}));
  expect(readProjectDecisionSources(manifest,selected).items[0].sessionMatch).toBeUndefined();
  expect(readProjectDecisionSources(manifest,new Set()).items).toEqual([]);
  expect(readProjectDecisionSources(manifest,new Set(["other"])).diagnostics?.issues[0]).toMatchObject({ kind: "source", source: "production" });
  expect(readProjectDecisionSources(join(directory,"missing.json"),selected).items).toEqual([]);
});

function fixture(run: (context: {
  ledger: string; read: () => ReturnType<typeof readProjectDecisionSources>; snapshot: () => unknown;
}) => void) {
  const root = mkdtempSync(join(tmpdir(), "board-ledger-reading-"));
  try {
    const manifest = join(root, "manifest.json");
    const ledger = join(root, "decisions.json");
    const selected = new Set(["studio"]);
    const read = () => readProjectDecisionSources(manifest, selected);
    const store = new TrackedDecisionStore(join(root, "tracked-decisions.json"), read);
    writeFileSync(manifest, JSON.stringify({ version: 1, sources: [{ source: "releases", projectId: "studio", projectTitle: "Studio", directory: root }] }));
    run({ ledger, read, snapshot: () => trackedDecisionViewSchema.parse(store.read(selected, [], { items: [], projects: [] })) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const valid = { id: "working", title: "Review sample", where: "human" };
const malformed = { id: "bad-choices", title: "Fix sample choices", questions: [{ text: "Which take?", options: [{ key: "A", label: "First", detail: "Summary" }] }] };

test("a mixed ledger imports the valid cards and exposes concise field errors on the decision view", () => {
  fixture(({ ledger, read, snapshot }) => {
    writeFileSync(ledger, JSON.stringify({ items: [valid, malformed, { id: "bad-qa", title: "Review", qa: [{ a: "Missing question" }] }, {
      id: "old-alias", title: "Check formatting", questions: [{ text: "Which take?", options: [{ key: "A", text: "First", detail: "Summary" }] }],
    }] }));
    expect(read().items.map(row => row.id)).toEqual(["working"]);
    expect(snapshot()).toMatchObject({
      status: "partial", items: [{ id: "working" }], diagnostics: {
        count: 3, issues: [
          { kind: "entry", source: "releases", projectTitle: "Studio", id: "bad-choices", title: "Fix sample choices", fields: [
            { path: "questions.0.options.0.text", reason: "missing" },
            { path: "questions.0.options.0.label", reason: "invalid" },
            { path: "questions.0.options.0.detail", reason: "invalid" },
          ] },
          { id: "bad-qa", fields: [{ path: "qa.0.q", reason: "missing" }] },
          { id: "old-alias", fields: [{ path: "questions.0.options.0.detail", reason: "invalid" }] },
        ],
      },
    });
  });
});

test("unreadable, broken JSON and missing items fail that ledger with its source name", () => {
  fixture(({ ledger, snapshot }) => {
    const expected = { status: "partial", items: [], diagnostics: { count: 1, issues: [{ kind: "source", source: "releases", projectTitle: "Studio" }] } };
    expect(snapshot()).toMatchObject(expected);
    for (const raw of ["{ broken", "{}", '{"items":{}}']) {
      writeFileSync(ledger, raw);
      expect(snapshot()).toMatchObject(expected);
    }
  });
});

test("an all-invalid ledger remains partial and reports record positions when IDs are absent", () => {
  fixture(({ ledger, snapshot }) => {
    writeFileSync(ledger, JSON.stringify({ items: [malformed, { title: "No identity" }, null] }));
    expect(snapshot()).toMatchObject({ status: "partial", items: [], diagnostics: {
      count: 3, issues: [
        { kind: "entry", id: "bad-choices", row: 1 },
        { kind: "entry", title: "No identity", row: 2, fields: [{ path: "id", reason: "missing" }] },
        { kind: "entry", row: 3, fields: [{ path: "", reason: "invalid" }] },
      ],
    } });
  });
});

test("diagnostics preserve valid cards with unreadable supplemental history, and contain only bounded diagnostic metadata", () => {
  fixture(({ ledger, snapshot }) => {
    mkdirSync(join(ledger, "..", "live", "board-answers.tsv"), { recursive: true });
    const many = Array.from({ length: 55 }, () => ({ ...malformed, title: "Test\u202e\n" + "L".repeat(1000) }));
    writeFileSync(ledger, JSON.stringify({ items: [valid, ...many] }));
    const result = snapshot() as { items: { id: string }[]; diagnostics: { count: number; issues: { title?: string; fields?: unknown[] }[] } };
    expect(result.items.map(item => item.id)).toEqual(["working"]);
    expect(result.diagnostics.count).toBe(56);
    expect(result.diagnostics.issues.length).toBeLessThan(result.diagnostics.count);
    const title = result.diagnostics.issues.find(issue => issue.title)?.title ?? "";
    expect(title.length).toBeLessThan(1000);
    expect(title).not.toMatch(/[\u202e\n]/);
    expect(result.diagnostics.issues[0]).toMatchObject({ kind: "history", part: "answers" });
  });
});

test("duplicate IDs do not select either ambiguous card and leave unrelated cards visible", () => {
  fixture(({ ledger, snapshot }) => {
    writeFileSync(ledger, JSON.stringify({ items: [valid, { id: "copy", title: "First copy" }, { id: "copy", title: "Second copy" }] }));
    expect(snapshot()).toMatchObject({ items: [{ id: "working" }], diagnostics: {
      count: 2, issues: [{ id: "copy", row: 2, fields: [{ path: "id", reason: "duplicate" }] }, { id: "copy", row: 3 }],
    } });
  });
});
