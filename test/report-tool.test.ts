import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteStore } from "../server/notes";
import { attachReportTool } from "../server/reporting";
import { reportingKey } from "../shared/contract";

test("only opted-in interactive sessions get the reporting tool, and revocation takes effect immediately", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-hook-"));
  try {
    const store = new NoteStore(join(root, "notes.json"));
    let open;
    attachReportTool({ addHook: (_event, hook) => { open = hook; return () => {}; } }, store);
    const request = { purpose: "interactive", metadata: {}, tools: [{ name: "existing" }] };
    expect(await open({ request })).toBeUndefined();
    const selected = { ...request, metadata: { [reportingKey]: true } };
    expect(await open({ request: { ...selected, purpose: "history" } })).toBeUndefined();
    const opened = await open({ request: selected });
    expect(opened.tools.map(t => t.name)).toEqual(["existing", "report_to_board"]);
    let enabled = true;
    const ctx = {
      agent: { id: "mine" },
      paseo: { agents: { ref: id => {
        expect(id).toBe("mine");
        return { refresh: async () => {}, metadata: { [reportingKey]: enabled }, archivedAt: null };
      } } },
    };
    const tool = opened.tools[1];
    const report = { kind:"review", text:"Test receipt" };
    expect(tool.input.safeParse({...report,kind:"done"}).success).toBe(false);
    await tool.execute(report,ctx);
    expect(store.visible(new Set(["mine"])).mine.origin).toBe("agent");
    enabled = false;
    expect((await tool.execute({...report,text:"second"},ctx)).isError).toBe(true);
    expect(store.visible(new Set(["mine"])).mine.text).toBe(report.text);
  } finally { rmSync(root, {recursive:true,force:true}); }
});
