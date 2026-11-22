import type { BoardReadiness } from "../shared/readiness";
import { ReplyHistory } from "./reply-history";
import { TrackedDecisionCard } from "./tracked-decisions";
import { trackedCoverage, trackedRecipient, pullKey, type TrackedDecision } from "../shared/tracked-decisions";
import { MergeFeedback, PullRequestCard, PullRequestSettings, type MergeNotice, type WorkSessionLink } from "./pull-requests";
import { decisionCount } from "../shared/decision-count";
import { matchesWorkspace } from "../shared/workspace-pull";
import type { PullRequestItem } from "../shared/prs";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { DecisionActions, ReceiptText, type DecisionReceipt } from "./decision-actions";
import { SessionLinks } from "./session-links";
import { useRemoteRunning, RemoteRunning } from "./remote-running";
import { BoardHosts } from "./hosts";
import { OperationsPanel } from "./operations";
import { Button, type Theme } from "./controls";
import { Project } from "./project-kanban";
import { BoardLanguageSetting, useBoardLanguage } from "./language";
import { projectCards, type Card, type Snapshot } from "./model";

type Actions = { sessionHostLabel?: string; coordinator?: string | null; onCoordinator?: (id: string | null) => void; changing?: boolean; onOpen?: (id: string) => void; onEdit: (id: string) => void };

export type BoardViewProps = Actions & {
  theme: Theme; layout: PluginScreenProps["layout"]; hostLabel: string; hostId?: string; onOpenHostSession?: (serverId: string, agentId: string) => void;
  readiness?: BoardReadiness | null; snapshot: Snapshot | null; error: string | null; loading: boolean; updatedAt: Date | null;
  onRefresh: () => void; onProject?: (id: string, enabled: boolean) => void;
};

export function BoardView({ snapshot, readiness, theme, layout, hostLabel, hostId, onOpenHostSession, error, loading, updatedAt, onRefresh, onProject, ...actions }: BoardViewProps) {
  const { t, language } = useBoardLanguage();
  const { human, projects } = useMemo(() => snapshot ? projectCards(snapshot) : { human: [], projects: [] }, [snapshot]);
  const pullRequests = snapshot?.pullRequests;
  const readyPrs = pullRequests?.items.filter(pr => pr.lane === "review") ?? [];
  const records = useMemo(() => {
    const priority = (urgency: string | null | undefined) => ["now","today","week"].includes(urgency ?? "") ? ["now","today","week"].indexOf(urgency!) : 3;
    return [...snapshot?.trackedDecisions?.items ?? []].sort((a,b) => priority(a.urgency) - priority(b.urgency) ||
      (a.where === "human" ? 0 : 1) - (b.where === "human" ? 0 : 1) || (a.since ?? "~").localeCompare(b.since ?? "~"));
  }, [snapshot?.trackedDecisions]);
  const total = snapshot ? decisionCount(snapshot) : 0;
  const names = new Map(snapshot?.projects.map(project => [project.id, project.title]));
  const displayed = new Map(projects.map(project => [project.id, project]));
  for (const pr of pullRequests?.items ?? []) for (const id of pr.projectIds) {
    if (!displayed.has(id)) displayed.set(id, {id,title:names.get(id) ?? id,cards:[]});
  }
  function decisionsFor(inScope:(id:string|null)=>boolean) {
    const visibleRecords=records.filter(item=>inScope(item.projectId));
    const covered=trackedCoverage(visibleRecords);
    return {
      records:visibleRecords,
      sessions:human.filter(card=>inScope(card.session.projectId) && !covered.sessionIds.has(card.session.id)),
      prs:readyPrs.filter(pr=>pr.projectIds.some(inScope) && !covered.pullKeys.has(pullKey(pr.repo,pr.number))),
    };
  }
  const byProject=new Map<string|null,number>();
  const projectIds=new Set<string|null>(snapshot?.projects.filter(p=>p.selected).map(p=>p.id));
  for (const item of records) {
    projectIds.add(item.projectId);
    if (item.projectId && !displayed.has(item.projectId)) displayed.set(item.projectId,{id:item.projectId,title:names.get(item.projectId) ?? item.projectTitle ?? item.projectId,cards:[]});
  }
  const history = snapshot?.replyHistory ?? [];
  for (const entry of history) {
    projectIds.add(entry.projectId);
    if (entry.projectId && !displayed.has(entry.projectId)) displayed.set(entry.projectId,{id:entry.projectId,title:names.get(entry.projectId) ?? entry.projectId,cards:[]});
  }
  for (const id of projectIds) {
    const list=decisionsFor(projectId=>projectId===id);
    byProject.set(id,list.records.length+list.sessions.length+list.prs.length);
  }
  const [showFilters, setShowFilters] = useState(false);
  const [chosenProjects,setChosenProjects]=useState<(string|null)[]>([]);
  const filters=chosenProjects.filter(id=>byProject.has(id));
  const inFilter=(id:string|null)=>!filters.length || filters.includes(id);
  const {records:filteredRecords,sessions:filteredSessions,prs:filteredPrs}=decisionsFor(inFilter);
  const filteredTotal=filteredRecords.length+filteredSessions.length+filteredPrs.length;
  const projectName=(id:string|null)=>names.get(id ?? "") ?? id ?? t("공통","Host-wide");
  function toggleFilter(id:string|null) {
    setChosenProjects(previous=>{
      const active=previous.filter(value=>byProject.has(value));
      return active.includes(id) ? active.filter(value=>value!==id) : [...active,id];
    });
  }
  const incomplete = snapshot?.trackedDecisions && ["partial","unavailable","invalid"].includes(snapshot.trackedDecisions.status);
  const [settings, setSettings] = useState(false);
  const peers = useRemoteRunning({id:hostId ?? "",label:hostLabel}, snapshot?.projects ?? [], pullRequests?.projects ?? [], !!hostId && !settings);
  const [showError, setShowError] = useState(false);
  const [manage, setManage] = useState(false);
  const [pickSession, setPickSession] = useState(false);
  const configured = snapshot ? snapshot.projects.some(p => p.selected) : readiness?.configured;
  const pickingProjects = !configured || (!settings && !snapshot?.coordinator);
  const coordinatorId = snapshot ? snapshot.coordinator : readiness?.coordinator;
  const operationsReady = !!snapshot || !!(readiness?.configured && readiness.coordinator && !settings);
  const openCoordinator = coordinatorId && actions.onOpen ? () => actions.onOpen?.(coordinatorId) : undefined;
  const [digestLimit, setDigestLimit] = useState(5);
  const [mergeNotice, setMergeNotice] = useState<MergeNotice | null>(null);
  const mergeResult = (notice: MergeNotice) => { setMergeNotice(notice); onRefresh(); };
  const [receipts, setReceipts] = useState<DecisionReceipt[]>([]);
  const remaining = [filteredRecords.length, filteredSessions.length, filteredPrs.length].reduce((sum,n) => sum + Math.max(0, n - digestLimit), 0);
  const matches = (r: DecisionReceipt, card: Card) => r.projectId === card.session.projectId && r.sessionId === card.session.id && r.version === card.session.decision?.version;
  const latestMoved = receipts.find(r => inFilter(r.projectId) && snapshot?.projects.some(p => p.id === r.projectId && p.selected) && !human.some(card => card.session.id === r.sessionId && card.session.projectId === r.projectId));
  const renderDecision = (card: Card) => <DecisionActions key={JSON.stringify([card.session.projectId, card.session.id, card.session.decision?.version])}
          card={card} hostLabel={hostLabel} theme={theme} coordinator={snapshot!.coordinator} coordinatorTitle={snapshot!.sessions.find(s => s.id === snapshot!.coordinator)?.title}
          open={actions.onOpen} receipt={receipts.find(r => matches(r, card))}
          onSent={result => {
            setReceipts(prior => [result, ...prior.filter(r => !(r.projectId === result.projectId && r.sessionId === result.sessionId))].slice(0, 20));
            onRefresh();
          }} />;
  function linkedSession(item: TrackedDecision) {
    const id = item.matchedSessionId || item.sessionId;
    if (!id) return;
    if (item.sessionHost && item.sessionHost !== hostId) {
      const peer = peers.find(g => g.host.serverId === item.sessionHost && g.rows.some(s => s.sessionId === id && s.projectId === item.projectId));
      return peer && onOpenHostSession ? () => onOpenHostSession(peer.host.serverId,id) : undefined;
    }
    const local = snapshot?.sessions.find(s => s.id === id && (s.projectId === item.projectId || s.id === item.matchedSessionId));
    return local && actions.onOpen ? () => actions.onOpen!(local.id) : undefined;
  }
  function renderPull(pr:PullRequestItem, projectId:string, decision=false) {
    const workSessions:WorkSessionLink[] = [];
    for (const s of snapshot?.sessions ?? []) {
      if (!pr.projectIds.includes(s.projectId) || !actions.onOpen || !matchesWorkspace(pr,s.workspacePull)) continue;
      const state = s.status === "closed" ? t("대화 종료","Closed") : s.lane === "running" ? t("진행 중","Running") : s.status === "idle" ? t("대기","Idle") : t("상태 확인 필요","Check status");
      workSessions.push({key:JSON.stringify([hostId,s.id]),label:[s.title,hostLabel,state].join(" · "),open:()=>actions.onOpen!(s.id)});
    }
    if (onOpenHostSession) for (const {host,rows} of peers) for (const s of rows) {
      if (!pr.projectIds.includes(s.projectId) || !matchesWorkspace(pr,s.workspacePull)) continue;
      workSessions.push({key:JSON.stringify([host.serverId,s.sessionId]),label:[s.title || t("작업 세션","Work session"),host.label,t("진행 중","Running")].join(" · "),open:()=>onOpenHostSession(host.serverId,s.sessionId)});
    }
    return <PullRequestCard key={JSON.stringify([pr.url,projectId])} pr={pr} projectId={projectId} theme={theme} workSessions={workSessions}
      decision={decision} openCoordinator={openCoordinator} onResult={mergeResult} />;
  }
  const renderRecord = (item: TrackedDecision) => {
          const native = human.find(card => card.session.id === item.matchedSessionId);
          const pr = item.matchedPull && readyPrs.find(pr => pr.repo === item.matchedPull?.repo && pr.number === item.matchedPull.number);
          return <TrackedDecisionCard key={item.key} item={item} theme={theme}
            recipientId={native && !item.questions.length ? undefined : trackedRecipient(item,snapshot!.coordinator,snapshot!.sessions)} open={!native ? linkedSession(item) : undefined} onResolved={onRefresh}>
            {native && renderDecision(native)}
            {pr && renderPull(pr, pr.projectIds.includes(item.projectId ?? "") ? item.projectId! : pr.projectIds[0], true)}
          </TrackedDecisionCard>;
        };
  const c = theme.colors;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ gap: 20, padding: layout.compact ? 12 : 22 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <View style={{ flex: 1, minWidth: 140, gap: 3 }}>
          <Text style={{ color: c.foreground, fontSize: 22, fontWeight: "700" }} accessibilityRole="header">{settings ? t("코디네이터 보드 설정", "Coordinator board settings") : t("세션별 코디네이터 보드", "Session coordinator board")}</Text>
          {error ? <Text accessibilityRole="button" accessibilityLiveRegion="polite" onPress={() => setShowError(open => !open)}
            style={{ color: c.statusDanger, fontSize: 13, textDecorationLine: "underline" }}>
            {snapshot ? t("갱신 실패 · 이전 결과 표시 · 오류 상세", "Refresh failed · Showing last result · Details") : t("조회 실패 · 오류 상세", "Could not load sessions · Details")}
          </Text> : <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{[hostLabel, updatedAt ? (language === "ko" ? `${updatedAt.toLocaleTimeString("ko-KR")} 갱신` : `Updated ${updatedAt.toLocaleTimeString("en-US")}`) : t("세션 조회 중…", "Loading sessions…")].filter(Boolean).join(" · ")}</Text>}
        </View>
        {!settings && <Button theme={theme} label={loading ? t("조회 중…", "Refreshing…") : t("새로 고침", "Refresh")} onPress={onRefresh} disabled={loading} />}
        <Button theme={theme} label={settings ? t("보드로 돌아가기", "Back to board") : t("설정", "Settings")} onPress={() => {
          setSettings(!settings); setManage(false); setPickSession(false);
        }} />
      </View>
      {!!error && showError && <Text selectable style={{ color: c.statusDanger }}>{error}</Text>}
      {settings && <BoardLanguageSetting theme={theme} />}
      {!!error && settings && <Button theme={theme} label={t("세션 다시 조회", "Retry session lookup")} disabled={loading} onPress={onRefresh} />}
      {snapshot && onProject && (pickingProjects || settings) && <View style={{ gap: 7 }}>
        {!pickingProjects
          ? <Button theme={theme} label={manage ? t("프로젝트 관리 닫기", "Close project selection") : t("보드에서 관리할 프로젝트 선택", "Choose projects to manage")} onPress={() => setManage(!manage)} />
          : <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }}>{t("다이제스트에서 관리할 프로젝트 선택", "Select projects for your digest")}</Text>}
        {(pickingProjects || manage) && <>
          <Text style={{ color: c.foregroundMuted }}>{t("선택한 프로젝트의 최근 대화를 읽어 내 결정을 찾습니다. 코디네이터를 지정하면 그 세션도 선택한 프로젝트의 발췌를 볼 수 있습니다.", "The board reads recent conversations in selected projects to find decisions. The assigned coordinator can also read excerpts from those projects.")}</Text>
          {snapshot.projects.map(p => <Button key={p.id} theme={theme} selected={p.selected} disabled={actions.changing}
            label={`${p.selected ? t("관리에서 제외", "Remove") : t("추가", "Add")} · ${p.title}${snapshot.projects.some(x => x.id !== p.id && x.title === p.title) ? " · " + (p.path || p.id) : ""}`}
            onPress={() => onProject(p.id, !p.selected)} />)}
        </>}
      </View>}
      {settings && snapshot && configured && <SessionLinks projects={snapshot.projects} theme={theme} onChange={onRefresh} />}
      {settings && pullRequests && !!configured && <PullRequestSettings view={pullRequests} names={names} theme={theme} refresh={onRefresh} />}
      {settings && hostId && <>
        <BoardHosts current={{ id: hostId, label: hostLabel }} settings theme={theme} open={onOpenHostSession} />
        <BoardHosts current={{ id: hostId, label: hostLabel }} settings={false} theme={theme} open={onOpenHostSession} />
      </>}
      <OperationsPanel settings={operationsReady && settings} theme={theme} coordinator={operationsReady ? coordinatorId ?? null : null} configured={operationsReady && !!configured}
        refreshBoard={onRefresh} openCoordinator={actions.onOpen} />
      {settings && snapshot && actions.onCoordinator && <View style={{ gap: 8 }}>
        <Button theme={theme} label={pickSession ? t("기존 세션 목록 닫기", "Close session list") : t("기존 세션에서 코디네이터 지정", "Choose an existing coordinator session")} onPress={() => setPickSession(!pickSession)} />
        {pickSession && <>
          {snapshot.coordinator && <Button theme={theme} disabled={actions.changing} label={t("현재 코디네이터 지정 해제", "Clear current coordinator")} onPress={() => actions.onCoordinator?.(null)} />}
          {snapshot.sessions.filter(s => s.id !== snapshot.coordinator).map(s => <Button key={s.id} theme={theme} disabled={actions.changing}
            label={`${s.projectTitle} · ${s.title} · ${t("지정", "Assign")}`} onPress={() => actions.onCoordinator?.(s.id)} />)}
          {!snapshot.sessions.length && <Text style={{ color: c.foregroundMuted }}>{t("관리할 프로젝트를 선택하면 지정할 수 있는 세션이 표시됩니다.", "Select a project to see its available sessions.")}</Text>}
        </>}
      </View>}
      {!settings && snapshot && configured && <View style={{ gap: 10, padding: 14, borderWidth: 1, borderColor: total ? c.statusWarning : c.border, borderRadius: 10, backgroundColor: c.surface1 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "700" }}>{filters.length ? t(`내 결정 · ${filteredTotal}건 / 전체 ${total}건`, `My decisions · ${filteredTotal} of ${total}`) : t(`내 결정 · ${total}건`, `My decisions · ${total}`)}</Text>
        {byProject.size > 1 && <View style={{gap: 6}}>
          <Button theme={theme} accessibilityLabel={t("프로젝트로 좁혀 보기", "Filter by project")} expanded={showFilters}
            label={t("프로젝트로 좁혀 보기", "Filter by project") + " · " + (filters.length ? t(`${filters.length}개 선택`,`${filters.length} selected`) : t("전체","All"))}
            onPress={() => setShowFilters(value => !value)} />
          {showFilters && <View style={{flexDirection:"row",flexWrap:"wrap",gap:4}}>
            <Button theme={theme} label={t(`전체 ${total}`,`All ${total}`)} selected={!filters.length} onPress={() => setChosenProjects([])} />
            {[...byProject].map(([id,count]) => <Button key={JSON.stringify(id)} theme={theme} toggle selected={filters.includes(id)}
              label={`${projectName(id)} · ${count}`} onPress={() => toggleFilter(id)} />)}
          </View>}
        </View>}
        <ReplyHistory entries={history.filter(entry=>inFilter(entry.projectId))} theme={theme} open={actions.onOpen} />
        {incomplete &&
          <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>{t("일부 결정 기록을 읽지 못했습니다. 현재 건수에는 확인한 항목만 포함됩니다.", "Some decision records could not be loaded. The count includes the available items.")}</Text>}
        {filters.length > 0 && !filteredTotal && total > 0 && !incomplete && <Text style={{color:c.foregroundMuted}}>{t("선택한 프로젝트에 결정할 일이 없습니다.","No decisions in the selected projects.")}</Text>}
        {total === 0 && !incomplete && <Text style={{ color: c.foregroundMuted }}>{t("지금 결정할 일이 없습니다.", "No decisions are waiting for you.")}</Text>}
        {mergeNotice && inFilter(mergeNotice.projectId) && snapshot.projects.some(p => p.selected && p.id === mergeNotice.projectId) && (mergeNotice.status === "merged" || mergeNotice.status === "already-merged" ||
          !readyPrs.some(pr => pr.repo + " #" + pr.number === mergeNotice.target)) && <MergeFeedback notice={mergeNotice} theme={theme} />}
        {filteredPrs.slice(0,digestLimit).map(pr => renderPull(pr,pr.projectIds.find(inFilter) ?? pr.projectIds[0],true))}
        {latestMoved && <ReceiptText receipt={latestMoved} theme={theme} />}
        {filteredRecords.slice(0,digestLimit).map(renderRecord)}
        {filteredSessions.slice(0,digestLimit).map(renderDecision)}
        {remaining > 0 && <Button theme={theme} label={t(`결정 ${remaining}건 더 보기`, `Show ${remaining} more decisions`)} onPress={() => setDigestLimit(total)} />}
      </View>}
      {!settings && snapshot && !displayed.size && (configured || !snapshot.projects.length) && <Text style={{ color: c.foregroundMuted }}>{t("표시할 세션이 없습니다. 워크스페이스에서 세션을 시작하면 여기에 나타납니다.", "Start a session in a workspace to see it here.")}</Text>}
      {!settings && (displayed.size > 0 || byProject.has(null)) && <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 19, fontWeight: "700" }}>{t("프로젝트별 진행", "Project progress")}</Text>}
      {!settings && byProject.has(null) && <Project projectId="" title={t("공통","Host-wide")} cards={[]} requests={[]} history={history.filter(entry=>entry.projectId === null)}
        records={records.filter(item=>item.projectId === null)} decisions={byProject.get(null) ?? 0} renderRecord={renderRecord} renderPull={renderPull}
        openRecord={linkedSession} compact={layout.compact} theme={theme} {...actions} />}
      {!settings && [...displayed.values()].map((p) => <Project projectId={p.id} history={history.filter(entry=>entry.projectId===p.id)} records={records.filter(r => r.projectId === p.id)} renderRecord={renderRecord} decisions={byProject.get(p.id) ?? 0} sessionHostLabel={hostLabel} renderPull={renderPull} openRecord={linkedSession} requests={pullRequests?.items.filter(pr => pr.projectIds.includes(p.id)) ?? []} key={p.id} title={p.title} cards={p.cards} compact={layout.compact} theme={theme} {...actions} />)}
      {!settings && hostId && snapshot && configured && <RemoteRunning groups={peers}
        projects={snapshot.projects} open={onOpenHostSession} theme={theme} />}
    </ScrollView>
  );
}
