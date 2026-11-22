import { expect, test } from "bun:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { PreferenceStore } from "../server/preferences";
import { sendCoordinatorRequest, digestPrompt } from "../server/digest";

function fixture() {
  let owner = "primary";
  const state = { status: "idle", archivedAt: null, activeTurn: null, pendingPermissions: [] as unknown[] };
  const sent: { target: string; text: string; options: { messageId: string; activeTurnBehavior: string } }[] = [];
  const prefs = { read: () => ({ coordinator: owner, projects:["selected"] }) } as PreferenceStore;
  let afterRefresh = () => {};
  const api = {
    agents: {
      ref: (target: string) => ({
        refresh: async () => {
          afterRefresh();
          return { agent: state };
        },
        send: async (text: string, options: (typeof sent)[number]["options"]) => {
          sent.push({ target, text, options });
        },
      }),
    },
  } as unknown as PluginHandlerContext["paseo"];
  return {
    state,
    sent,
    request: () => sendCoordinatorRequest(api, prefs, "primary", "digest-request-1", digestPrompt),
    rotate: () => {
      afterRefresh = () => {
        owner = "replacement";
      };
    },
  };
}
test("a person requests the digest from the designated idle session with a stable delivery key", async () => {
  const f = fixture();
  await f.request();
  await f.request();
  expect(f.sent.map((s) => s.target)).toEqual(["primary", "primary"]);
  expect(f.sent[0].options.messageId).toBe(f.sent[1].options.messageId);
  expect(f.sent[0].text).toContain("조회와 분류");
});
test("pending approval, a busy session or a concurrent rotation prevents a digest send", async () => {
  const f = fixture();
  f.state.pendingPermissions.push({});
  await expect(f.request()).rejects.toThrow();
  f.state.pendingPermissions = [];
  f.state.status = "running";
  await expect(f.request()).rejects.toThrow();
  f.state.status = "idle";
  f.rotate();
  await expect(f.request()).rejects.toThrow();
  expect(f.sent).toHaveLength(0);
});
