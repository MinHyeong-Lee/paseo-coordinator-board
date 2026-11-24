import { expect, test } from "bun:test";
import { groupProjects, visibleProjectFilters, selectedProjectIds, toggleProjectFilter, isTemporaryProject } from "../client/project-filters";

const project = (id: string, title = id, path = "/work/" + id, rootKey?: string) => ({
  id, title, path, rootKey, selected: true,
});

test("projects on the same folder share one filter and a combined selection", () => {
  const groups = groupProjects([
    project("one", "Studio", "/work/Studio", "root-1"),
    project("alias", "Studio", "/work/studio", "root-1"),
    project("other", "Studio", "/backup/Studio", "root-2"),
    project("solo", "Library"),
    { ...project("deleted"), missing: true },
    { ...project("unmanaged"), selected: false },
  ]);
  expect(groups.map(({ ids, label }) => [ids, label])).toEqual([
    [["one", "alias"], "Studio · work/Studio"],
    [["other"], "Studio · backup/Studio"],
    [["solo"], "Library"],
  ]);
  expect([...selectedProjectIds(groups, ["alias", "deleted"])]).toEqual(["one", "alias"]);
  expect(toggleProjectFilter(groups, ["alias", "other"], groups[0])).toEqual(["other"]);
  expect(toggleProjectFilter(groups, ["other"], groups[0])).toEqual(["other", "one", "alias"]);
});

test("unverified or distinct roots remain separate and unique project names stay short", () => {
  const groups = groupProjects([
    project("one", "Studio", "/work/Studio"),
    project("alias", "Alias", "/work/studio"),
    project("case", "Case", "/work/STUDIO", "root-2"),
  ]);
  expect(groups.map(group => group.label)).toEqual(["Studio", "Alias", "Case"]);
  expect(groups.map(group => group.ids)).toEqual([["one"], ["alias"], ["case"]]);
});

test("the collapsed row prioritizes three busy projects and keeps every current selection", () => {
  const groups = [
    { ids: ["idle"], label: "Idle", count: 0 },
    { ids: ["active", "alias"], label: "Active", count: 2 },
    { ids: ["largest"], label: "Largest", count: 9 },
    { ids: ["third"], label: "Third", count: 1 },
    { ids: ["second"], label: "Second", count: 3 },
    { ids: ["waiting"], label: "Waiting", count: 0 },
    { ids: [null], label: "Host-wide", count: 0 },
  ];
  const chosen = selectedProjectIds(groups, ["third", "idle", null, "missing"]);
  expect(visibleProjectFilters(groups, chosen, false)).toEqual({
    visible: [groups[2], groups[4], groups[1], groups[3], groups[6], groups[0]],
    hiddenCount: 1,
  });
  expect(visibleProjectFilters(groups, chosen, true)).toEqual({
    visible: [groups[2], groups[4], groups[1], groups[3], groups[6], groups[0], groups[5]],
    hiddenCount: 1,
  });
  expect(visibleProjectFilters([], chosen, false)).toEqual({ visible: [], hiddenCount: 0 });
});

test("temporary directory labels respect path boundaries and macOS aliases", () => {
  for (const path of ["/tmp", "/tmp/example", "/private/tmp/example", "/var/folders/ab/project", "/private/var/folders/ab/project"]) {
    expect(isTemporaryProject(path)).toBe(true);
  }
  for (const path of ["", "/tmp-notes", "/work/tmp/example", "/var/folders-old/project", "/tmp/../work"]) {
    expect(isTemporaryProject(path)).toBe(false);
  }
});
