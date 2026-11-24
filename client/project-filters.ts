import { projectFilterNames, type Snapshot } from "./model";

type ProjectId = string | null;
type ProjectGroup = { ids: ProjectId[]; label: string };
export type ProjectFilter = ProjectGroup & { count: number };

export function groupProjects(projects: Snapshot["projects"]): ProjectGroup[] {
  const roots = new Map<string, { project: Snapshot["projects"][number]; ids: string[] }>();
  for (const project of projects) {
    if (!project.selected || project.missing) continue;
    const key = project.rootKey ? "root:" + project.rootKey : "id:" + project.id;
    const group = roots.get(key);
    if (group) group.ids.push(project.id);
    else roots.set(key, { project, ids: [project.id] });
  }
  const groups = [...roots.values()];
  const names = projectFilterNames(groups.map(group => group.project));
  return groups.map(({ project, ids }) => ({ ids, label: names.get(project.id) ?? project.title }));
}

export function selectedProjectIds(groups: readonly ProjectGroup[], chosen: readonly ProjectId[]) {
  const ids = new Set(chosen);
  return new Set(groups.flatMap(group => group.ids.some(id => ids.has(id)) ? group.ids : []));
}

export function toggleProjectFilter(groups: readonly ProjectGroup[], chosen: readonly ProjectId[], group: ProjectGroup) {
  const active = selectedProjectIds(groups, chosen);
  return group.ids.some(id => active.has(id))
    ? [...active].filter(id => !group.ids.includes(id))
    : [...active, ...group.ids];
}

type FilterMetrics = {
  rowWidth: number;
  allWidth: number;
  toggleWidth: number;
  gap: number;
  chipWidth: (group: ProjectFilter) => number;
};

export function visibleProjectFilters(groups: readonly ProjectFilter[], selected: ReadonlySet<ProjectId>,
  { rowWidth, allWidth, toggleWidth, gap, chipWidth }: FilterMetrics) {
  const ordered = [...groups].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const chips = ordered.map(group => ({ group, space: chipWidth(group) + gap, pinned: group.ids.some(id => selected.has(id)) }));
  const chipSpace = chips.reduce((total, chip) => total + chip.space, 0);
  if (!chips.length || allWidth + chipSpace <= rowWidth) {
    return { ordered, collapsed: ordered, hiddenCount: 0, showToggle: false };
  }

  const pinnedSpace = chips.reduce((total, chip) => total + (chip.pinned ? chip.space : 0), 0);
  let available = rowWidth - allWidth - toggleWidth - gap - pinnedSpace;
  const collapsed = chips.flatMap(({ group, pinned, space }) => {
    if (pinned) return [group];
    if (space > available) return [];
    available -= space;
    return [group];
  });
  return { ordered, collapsed, hiddenCount: ordered.length - collapsed.length, showToggle: true };
}

export function isTemporaryProject(path: string) {
  if (!path.startsWith("/")) return false;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  const [first, second] = parts[0] === "private" ? parts.slice(1) : parts;
  return first === "tmp" || (first === "var" && second === "folders");
}
