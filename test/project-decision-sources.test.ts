import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readProjectDecisionSources } from "../server/project-decision-sources";

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
  const [a,b]=readProjectDecisionSources(manifest,selected);
  expect(a.sessionMatch?.question).toBe("Which take?");
  expect(a.mergeTarget).toBeUndefined();
  expect(a.replyHistory[0].text).toBe("Use take 2");
  expect(b.mergeTarget).toEqual({repo:"studio/app",number:2});
  expect(b).toMatchObject({blocksWork:true,dueAt:"2026-11-23"});
  expect(b.questions[0].options[0].text).toBe("Tomorrow");
  expect(readProjectDecisionSources(manifest,new Set(["studio"]))[0].sessionMatch).toBeUndefined();
  writeFileSync(join(directory,"decisions.json"),JSON.stringify({items:[{...first,ask:"Check the other take"}]}));
  expect(readProjectDecisionSources(manifest,selected)[0].sessionMatch).toBeUndefined();
  expect(readProjectDecisionSources(manifest,new Set())).toEqual([]);
  expect(()=>readProjectDecisionSources(manifest,new Set(["other"]))).toThrow();
  expect(readProjectDecisionSources(join(directory,"missing.json"),selected)).toEqual([]);
});

test("ledger PRs remain readable references without becoming merge targets", () => {
  const directory = mkdtempSync(join(tmpdir(), "board-source-"));
  try {
    const manifest = join(directory, "sources.json");
    const source = { source: "sample", projectId: "studio", projectTitle: "Studio", repository: "studio/app", directory };
    const selected = new Set(["studio"]);
    writeFileSync(manifest, JSON.stringify({ version: 1, sources: [source] }));
    writeFileSync(join(directory, "decisions.json"), JSON.stringify({ items: [
      { id: "approve", kind: "approval", title: "Approve the outline", pr: 42 },
      { id: "merge", kind: "merge", title: "Merge the outline", pr: 43 },
      { id: "ask", kind: "answer", title: "What changed in #44?" },
    ] }));

    const [approve, merge, ask] = readProjectDecisionSources(manifest, selected);
    expect(approve).toMatchObject({ kind: "approve", pullRepository: "studio/app", pullTarget: { repo: "studio/app", number: 42 } });
    expect(approve.mergeTarget).toBeUndefined();
    expect(merge.mergeTarget).toEqual({ repo: "studio/app", number: 43 });
    expect(merge.pullTarget).toEqual(merge.mergeTarget);
    expect(ask.pullRepository).toBe("studio/app");
    expect(ask.pullTarget).toBeUndefined();

    writeFileSync(manifest, JSON.stringify({ version: 1, sources: [{ ...source, repository: undefined }] }));
    const [unmapped] = readProjectDecisionSources(manifest, selected);
    expect(unmapped.pullRepository).toBeUndefined();
    expect(unmapped.pullTarget).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
