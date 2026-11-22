import { trackedRecipient } from "./shared/tracked-decisions";
import { boardReadiness } from "./shared/readiness";
import { SnapshotReads } from "./server/snapshot-reads";
import { readProjectDecisionSources } from "./server/project-decision-sources";
import { TrackedDecisionStore } from "./server/tracked-decisions";
import { ProjectPullRequests } from "./server/prs";
import { decisionCount } from "./shared/decision-count";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { boardDecisionCount, boardScope, boardSnapshot, reportingKey, saveNote, setReporting } from "./shared/contract";
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
import { registerRecommendation } from "./server/recommendation";
import { NoteStore } from "./server/notes";
import { BoardFacts } from "./server/board-facts";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(hostVisibility);
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const dataDir = join(home, "plugin-data", "coordinator-board");
  const notes = new NoteStore(join(dataDir, "notes.json"));

  const prefs = new PreferenceStore(join(dataDir, "scope.json"));
  const reader = new ConversationReader();
  const facts = new BoardFacts(prefs, notes, reader);
  facts.register(server);
  const operations = createOperations(prefs, join(home, "plugin-workspaces", "coordinator-board"), facts);
  operations.register(server);
  registerSessionLinks(server, prefs);
  const decisions = new DecisionSender(prefs, notes, reader);
  registerRecommendation(server, decisions);
  server.handle(sendDecision, (input, { paseo }) => decisions.send(paseo, input));
  const prs = new ProjectPullRequests(prefs);
  const tracked = new TrackedDecisionStore(join(dataDir, "tracked-decisions.json"),
    selected => {
      let partial = false;
      const items = readProjectDecisionSources(join(dataDir, "tracked-sources.json"), selected, () => { partial = true; });
      return {items,partial};
    });
  server.handle(boardReadiness, async () => {
    const scope = prefs.read();
    return { configured: scope.projects.length > 0, coordinator: scope.coordinator };
  });
  async function buildSnapshot(paseo: PluginHandlerContext["paseo"]) {
    // GitHub can take seconds even when Paseo already knows the current sessions.
    // Start both paths together, and consume both rejections via Promise.all.
    const catalogRead = paseo.projects.list();
    const [sessionView, fetched] = await Promise.all([
      (async () => {
        const [catalog, rows] = await Promise.all([catalogRead, discoverSessions(paseo)]);
        return buildSessionView(paseo, catalog, rows);
      })(),
      catalogRead.then(({ projects }) => prs.read(paseo, { projects })),
    ]);
    const { choices, sessions, evidence } = sessionView;
    const latest = prefs.read();
    const visible = sessions.filter(row => isCurrentMembership(row, latest));
    const visibleNotes = notes.visible(new Set(visible.map(s => s.id)));
    facts.decorate(visible, evidence, visibleNotes);
    for (const row of visible) decorateDecision(row, visibleNotes[row.id], latest);
    const selected = new Set(latest.projects);
    const pullRequests = {
      projects: fetched.projects.filter(p => selected.has(p.projectId)),
      items: fetched.items.map(pr => ({ ...pr, projectIds: pr.projectIds.filter(id => selected.has(id)) })).filter(pr => pr.projectIds.length),
    };
    const trackedDecisions = tracked.read(selected, visible, pullRequests);
    return { sessions: visible, notes: visibleNotes, pullRequests, trackedDecisions,
      projects: [...choices.values()].map(p => ({ ...p, selected: selected.has(p.id) })), coordinator: latest.coordinator };
  }
  async function buildSessionView(paseo: PluginHandlerContext["paseo"],
    catalog: Awaited<ReturnType<PluginHandlerContext["paseo"]["projects"]["list"]>>,
    rows: Awaited<ReturnType<typeof discoverSessions>>) {
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
    const evidence = await reader.decorate(paseo, sessions, scope);
    return { choices, sessions, evidence };
  }
  const reads = new SnapshotReads<Awaited<ReturnType<typeof buildSnapshot>>>(() => {
    const { projects, sessionLinks, coordinator, projectRepositories } = prefs.read();
    return JSON.stringify([projects, sessionLinks, coordinator, projectRepositories]);
  }, decisionCount);
  const invalidateCount = () => reads.invalidate();
  prs.register(server, invalidateCount);
  tracked.register(server, () => new Set(prefs.read().projects), invalidateCount, async (item,targetId,{paseo}) => {
    const rows=await discoverSessions(paseo);
    const current=()=>{
      const scope=prefs.read();
      return scope.projects.length>0 && (!item.projectId || scope.projects.includes(item.projectId)) &&
        trackedRecipient(item,scope.coordinator,managedSessions(rows,scope))===targetId;
    };
    if (!current()) return null;
    const handle=paseo.agents.ref(targetId);
    const agent=(await handle.refresh())?.agent;
    if (!current() || !agent || agent.id!==targetId || agent.internal || agent.archivedAt) return null;
    return {
      stillCurrent:current,
      send:async (answer,messageId)=>{
        await handle.send(answer,{messageId,activeTurnBehavior:"steer"});
      },
      accepted:async (answer,messageId)=>{
        const page=await handle.timeline.refetch({direction:"tail",projection:"projected",limit:128});
        return !page.error && !page.gap && !page.staleCursor && page.entries.some(({item:m})=>m.type==="user_message" &&
          (m.messageId===messageId || m.clientMessageId===messageId) && m.text===answer);
      },
      ready:agent.status==="idle" && !agent.activeTurn && !agent.pendingPermissions.length && agent.attentionReason!=="permission",
    };
  });
  server.handle(boardSnapshot, (input, { paseo }) => reads.read(() => buildSnapshot(paseo), input.fresh));
  server.handle(boardDecisionCount, async (_input, { paseo }) => ({
    count: await reads.count(() => buildSnapshot(paseo)),
  }));
  server.handle(boardScope, async (change, { paseo }) => {
    const rows = await discoverSessions(paseo);
    if (change.kind === "project") {
      if (change.enabled && !rows.some(r => r.projectId === change.projectId)) {
        const catalog = await paseo.projects.list();
        if (!catalog.projects.some(p => p.projectId === change.projectId)) throw new Error("이 호스트에서 프로젝트를 찾을 수 없습니다.");
      }
      prefs.change(scope => {
        if (scope.projects.includes(change.projectId) !== change.enabled) delete scope.factCycle;
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
    invalidateCount();
    return { ok: true };
  });
  server.handle(saveNote, async (input, { paseo }) => {
    const sessions = await discoverSessions(paseo);
    if (!managedSessions(sessions, prefs.read()).some(session => session.id === input.sessionId)) {
      throw new Error("이 호스트에서 해당 세션을 찾지 못했습니다. 보드를 새로 고쳐 주세요.");
    }
    const outcome = notes.update(input);
    if (outcome.ok) invalidateCount();
    return outcome;
  });

  server.handle(setReporting, async ({ sessionId, enabled }, { paseo }) => {
    const sessions = await discoverSessions(paseo);
    if (!managedSessions(sessions, prefs.read()).some(session => session.id === sessionId)) throw new Error("세션을 찾지 못했습니다.");
    await paseo.agents.ref(sessionId).setMetadata({ [reportingKey]: enabled });
    invalidateCount();
    return { ok: true };
  });
  const removeReport = attachReportTool(server, notes);
  const removeCoordinator = attachCoordinatorTools(server, prefs, reader, [...operations.tools, facts.tool]);
  return () => { removeCoordinator(); removeReport(); };
}
