import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { boardScope, boardSnapshot, reportingKey, saveNote, setReporting } from "./shared/contract";
import { discoverSessions } from "./server/discovery";
import { attachReportTool } from "./server/reporting";
import { ConversationReader } from "./server/conversation";
import { setCoordinator, PreferenceStore } from "./server/preferences";
import { attachCoordinatorTools } from "./server/coordinator";
import { createOperations } from "./server/operations";
import { hostVisibility } from "./shared/hosts";
import { decorateDecision, DecisionSender } from "./server/decisions";
import { sendDecision } from "./shared/decision-actions";
import { isCurrentMembership, managedSessions, registerSessionLinks, releaseUnmanagedCoordinator } from "./server/session-links";
import { NoteStore } from "./server/notes";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(hostVisibility);
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const dataDir = join(home, "plugin-data", "coordinator-board");
  const notes = new NoteStore(join(dataDir, "notes.json"));

  const prefs = new PreferenceStore(join(dataDir, "scope.json"));
  const reader = new ConversationReader();
  const operations = createOperations(prefs, join(home, "plugin-workspaces", "coordinator-board"));
  operations.register(server);
  registerSessionLinks(server, prefs);
  const decisions = new DecisionSender(prefs, notes, reader);
  server.handle(sendDecision, (input, { paseo }) => decisions.send(paseo, input));
  server.handle(boardSnapshot, async (_input, { paseo }) => {
    const [rows, catalog] = await Promise.all([discoverSessions(paseo), paseo.projects.list()]);
    const scope = prefs.read();
    const choices = new Map(catalog.projects.map(p => {
      const id = p.projectId;
      return [id, { id, title: p.projectCustomName || p.projectDisplayName, path: p.projectRootPath, selected: scope.projects.includes(id) }];
    }));
    for (const row of rows) {
      if (!choices.has(row.projectId)) choices.set(row.projectId, { id: row.projectId, title: row.projectTitle, path: "", selected: scope.projects.includes(row.projectId) });
    }
    const titles = new Map([...choices].map(([id, p]) => [id, p.title]));
    const sessions = managedSessions(rows, scope, titles);
    await reader.decorate(paseo, sessions, scope);
    const latest = prefs.read();
    const visible = sessions.filter(row => isCurrentMembership(row, latest));
    const visibleNotes = notes.visible(new Set(visible.map(s => s.id)));
    for (const row of visible) decorateDecision(row, visibleNotes[row.id], latest);
    return { sessions: visible, notes: visibleNotes,
      projects: [...choices.values()].map(p => ({ ...p, selected: latest.projects.includes(p.id) })), coordinator: latest.coordinator };
  });
  server.handle(boardScope, async (change, { paseo }) => {
    const rows = await discoverSessions(paseo);
    if (change.kind === "project") {
      if (change.enabled && !rows.some(r => r.projectId === change.projectId)) {
        const catalog = await paseo.projects.list();
        if (!catalog.projects.some(p => p.projectId === change.projectId)) throw new Error("이 호스트에서 프로젝트를 찾을 수 없습니다.");
      }
      prefs.change(scope => {
        scope.projects = scope.projects.filter(id => id !== change.projectId);
        if (change.enabled) scope.projects.push(change.projectId);
        else {
          for (const link of Object.values(scope.sessionLinks)) {
            if (link.targetProjectId === change.projectId) delete scope.sessionLinks[link.sessionId];
          }
          releaseUnmanagedCoordinator(rows, scope);
          for (const [id, d] of Object.entries(scope.judgments)) if (d.projectId === change.projectId) delete scope.judgments[id];
        }
        reader.retain(new Set(managedSessions(rows, scope).map(r => r.id)));
      });
    } else {
      prefs.change(scope => {
        if (change.sessionId && !managedSessions(rows, scope).some(r => r.id === change.sessionId)) throw new Error("관리할 프로젝트의 세션을 선택해 주세요.");
        setCoordinator(scope, change.sessionId);
      });
    }
    return { ok: true };
  });
  server.handle(saveNote, async (input, { paseo }) => {
    const sessions = await discoverSessions(paseo);
    if (!managedSessions(sessions, prefs.read()).some(session => session.id === input.sessionId)) {
      throw new Error("이 호스트에서 해당 세션을 찾지 못했습니다. 보드를 새로 고쳐 주세요.");
    }
    return notes.update(input);
  });

  server.handle(setReporting, async ({ sessionId, enabled }, { paseo }) => {
    const sessions = await discoverSessions(paseo);
    if (!managedSessions(sessions, prefs.read()).some(session => session.id === sessionId)) throw new Error("세션을 찾지 못했습니다.");
    await paseo.agents.ref(sessionId).setMetadata({ [reportingKey]: enabled });
    return { ok: true };
  });
  const removeReport = attachReportTool(server, notes);
  const removeCoordinator = attachCoordinatorTools(server, prefs, reader, operations.tools);
  return () => { removeCoordinator(); removeReport(); };
}
