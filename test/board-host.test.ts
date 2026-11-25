import { expect, test } from "bun:test";
import { rememberBoardRoute, previousBoardRoute } from "../client/board-host";

test("reopening after visiting another host restores the most recently viewed board", () => {
  const data = new Map<string, string>();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (k, v) => data.set(k, v) } as Storage;
  const hosts = ["local", "remote"];
  const remote = "/h/remote/plugin/coordinator-board/surface/board";
  const reopen = () => previousBoardRoute(storage, "local", hosts, "ko");
  expect(reopen()).toBeNull();
  rememberBoardRoute(storage, remote, "remote");
  rememberBoardRoute(storage, "/h/local/workspace/work", "local");
  expect(reopen()).toBe(remote + "?param.language=ko");
  expect(previousBoardRoute(storage, "local", ["local"], "ko")).toBeNull();
  rememberBoardRoute(storage, remote.replace("remote", "local"), "local");
  expect(reopen()).toBeNull();
});
