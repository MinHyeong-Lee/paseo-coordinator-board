import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { DecisionActions, ReceiptText, type DecisionReceipt } from "./decision-actions";
import { SessionLinks } from "./session-links";
import { BoardHosts } from "./hosts";
import { OperationsPanel } from "./operations";
import { Button, type Theme } from "./controls";
import { columnWidth, COLUMN_GAP } from "./lane-width";
import { BoardLanguageSetting, useBoardLanguage } from "./language";
import { laneLabel, lanes, noteLabel, sessionDetail, projectCards, type Card, type Lane, type Snapshot } from "./model";

type Actions = { coordinator?: string | null; onCoordinator?: (id: string | null) => void; changing?: boolean; onOpen?: (id: string) => void; onEdit: (id: string) => void };

function accent(lane: Lane, theme: Theme) {
  const c = theme.colors;
  if (lane === "human") return c.statusWarning;
  if (lane === "running") return c.accent;
  if (lane === "done") return c.statusSuccess;
  return c.foregroundMuted;
}

function CardView({ card, theme, onOpen, onEdit }: { card: Card; theme: Theme } & Actions) {
  const { t } = useBoardLanguage();
  const { session, note } = card;
  const c = theme.colors;
  const runtime = [session.provider, session.model === session.provider ? null : session.model].filter(Boolean).join(" / ");
  const noteText = note && note.kind !== "clear" ? [note.origin === "agent" ? t("세션 보고", "Session report") : null, noteLabel(note.kind, t), note.text].filter(Boolean).join(" · ") : null;
  return (
    <View style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0, gap: 6 }}>
      <Text selectable style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>{session.title}</Text>
      <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{[session.sourceProjectTitle && t(`원래 소속 ${session.sourceProjectTitle}`, `From ${session.sourceProjectTitle}`), session.workspaceTitle, runtime].filter(Boolean).join(" · ")}</Text>
      {!!session.detail && <Text selectable style={{ color: c.foregroundMuted, fontSize: 13 }}>{sessionDetail(session.detail, t)}</Text>}
      {noteText && <Text selectable numberOfLines={3} style={{ color: c.foreground, fontSize: 13 }}>{noteText}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
        {onOpen && <Button theme={theme} label={t("세션 열기", "Open session")} accessibilityLabel={t(`세션 열기 · ${session.title}`, `Open session · ${session.title}`)} onPress={() => onOpen(session.id)} />}
        <Button theme={theme} label={noteText ? t("기록 편집", "Edit note") : t("기록 추가", "Add note")} accessibilityLabel={t(`기록 편집 · ${session.title}`, `Edit note · ${session.title}`)} onPress={() => onEdit(session.id)} />
      </View>
    </View>
  );
}

function Column({ lane, cards, theme, ...actions }: { lane: Lane; cards: Card[]; theme: Theme } & Actions) {
  const { t } = useBoardLanguage();
  const [limit, setLimit] = useState(4);
  const c = theme.colors;
  return (
    <View style={{ padding: 8, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: accent(lane, theme) }} />
        <Text style={{ flex: 1, color: c.foreground, fontSize: 14, fontWeight: "600" }}>{laneLabel(lane, t)}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{cards.length}</Text>
      </View>
      {cards.slice(0, limit).map((card) => <CardView key={card.session.id} card={card} theme={theme} {...actions} />)}
      {cards.length > limit && <Button theme={theme} label={t(`${cards.length - limit}개 중 더 보기`, `Show more (${cards.length - limit} remaining)`)} onPress={() => setLimit((n) => n + 10)} />}
    </View>
  );
}

function Project({ cards, title, theme, compact, ...actions }: { cards: Card[]; title: string; theme: Theme; compact: boolean } & Actions) {
  const { t } = useBoardLanguage();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<Lane | null>(null);
  const grouped = useMemo(() => {
    const groups: Record<Lane, Card[]> = { human: [], running: [], review: [], idle: [], done: [], unknown: [] };
    for (const card of cards) groups[card.lane].push(card);
    return groups;
  }, [cards]);
  const narrow = compact || (width > 0 && width < 720);
  const current = selected ?? lanes.find((lane) => grouped[lane].length > 0) ?? "running";
  const size = columnWidth(width, lanes.length);
  const c = theme.colors;
  return (
    <View style={{ gap: 8 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: "600", color: c.foreground }}>{title} <Text style={{ fontSize: 14, color: c.foregroundMuted }}>{cards.length}</Text></Text>
      {width === 0 && !compact ? null : narrow ? <>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
          {lanes.map((lane) => <Button theme={theme} key={lane} selected={lane === current} label={`${laneLabel(lane, t)} ${grouped[lane].length}`} onPress={() => setSelected(lane)} />)}
        </View>
        <Column key={current} lane={current} cards={grouped[current]} theme={theme} {...actions} />
      </> : <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ gap: COLUMN_GAP, paddingBottom: 5, alignItems: "flex-start" }}>
        {lanes.map((lane) => <View key={lane} style={{ width: size }}>
          <Column lane={lane} cards={grouped[lane]} theme={theme} {...actions} />
        </View>)}
      </ScrollView>}
    </View>
  );
}

export type BoardViewProps = Actions & {
  theme: Theme; layout: PluginScreenProps["layout"]; hostLabel: string; hostId?: string; onOpenHostSession?: (serverId: string, agentId: string) => void;
  snapshot: Snapshot | null; error: string | null; loading: boolean; updatedAt: Date | null;
  onRefresh: () => void; onProject?: (id: string, enabled: boolean) => void;
};

export function BoardView({ snapshot, theme, layout, hostLabel, hostId, onOpenHostSession, error, loading, updatedAt, onRefresh, onProject, ...actions }: BoardViewProps) {
  const { t, language } = useBoardLanguage();
  const { human, projects } = useMemo(() => snapshot ? projectCards(snapshot) : { human: [], projects: [] }, [snapshot]);
  const [settings, setSettings] = useState(false);
  const [showError, setShowError] = useState(false);
  const [manage, setManage] = useState(false);
  const [pickSession, setPickSession] = useState(false);
  const configured = snapshot?.projects?.some(p => p.selected);
  const pickingProjects = !configured || (!settings && !snapshot?.coordinator);
  const [digestLimit, setDigestLimit] = useState(5);
  const [receipts, setReceipts] = useState<DecisionReceipt[]>([]);
  const visible = human.slice(0, digestLimit);
  const matches = (r: DecisionReceipt, card: Card) => r.projectId === card.session.projectId && r.sessionId === card.session.id && r.version === card.session.decision?.version;
  const latestMoved = receipts.find(r => snapshot?.projects.some(p => p.id === r.projectId && p.selected) && !human.some(card => card.session.id === r.sessionId && card.session.projectId === r.projectId));
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
          ? <Button theme={theme} label={manage ? t("프로젝트 관리 닫기", "Close project selection") : t("관리 프로젝트 변경", "Manage projects")} onPress={() => setManage(!manage)} />
          : <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }}>{t("다이제스트에서 관리할 프로젝트 선택", "Select projects for your digest")}</Text>}
        {(pickingProjects || manage) && <>
          <Text style={{ color: c.foregroundMuted }}>{t("선택한 프로젝트의 최근 대화를 읽어 내 결정을 찾습니다. 코디네이터를 지정하면 그 세션도 선택한 프로젝트의 발췌를 볼 수 있습니다.", "The board reads recent conversations in selected projects to find decisions. The assigned coordinator can also read excerpts from those projects.")}</Text>
          {snapshot.projects.map(p => <Button key={p.id} theme={theme} selected={p.selected} disabled={actions.changing}
            label={`${p.selected ? t("관리에서 제외", "Remove") : t("추가", "Add")} · ${p.title}${snapshot.projects.some(x => x.id !== p.id && x.title === p.title) ? " · " + (p.path || p.id) : ""}`}
            onPress={() => onProject(p.id, !p.selected)} />)}
        </>}
      </View>}
      {settings && snapshot && configured && <SessionLinks projects={snapshot.projects} theme={theme} onChange={onRefresh} />}
      {settings && hostId && <BoardHosts current={{ id: hostId, label: hostLabel }} settings theme={theme} open={onOpenHostSession} />}
      {snapshot && <OperationsPanel settings={settings} theme={theme} coordinator={snapshot.coordinator} configured={!!configured}
        refreshBoard={onRefresh} openCoordinator={actions.onOpen} />}
      {settings && snapshot && actions.onCoordinator && <View style={{ gap: 8 }}>
        <Button theme={theme} label={pickSession ? t("기존 세션 목록 닫기", "Close session list") : t("기존 세션에서 코디네이터 지정", "Choose an existing coordinator session")} onPress={() => setPickSession(!pickSession)} />
        {pickSession && <>
          {snapshot.coordinator && <Button theme={theme} disabled={actions.changing} label={t("현재 코디네이터 지정 해제", "Clear current coordinator")} onPress={() => actions.onCoordinator?.(null)} />}
          {snapshot.sessions.filter(s => s.id !== snapshot.coordinator).map(s => <Button key={s.id} theme={theme} disabled={actions.changing}
            label={`${s.projectTitle} · ${s.title} · ${t("지정", "Assign")}`} onPress={() => actions.onCoordinator?.(s.id)} />)}
          {!snapshot.sessions.length && <Text style={{ color: c.foregroundMuted }}>{t("관리할 프로젝트를 선택하면 지정할 수 있는 세션이 표시됩니다.", "Select a project to see its available sessions.")}</Text>}
        </>}
      </View>}
      {!settings && snapshot && configured && <View style={{ gap: 10, padding: 14, borderWidth: 1, borderColor: human.length ? c.statusWarning : c.border, borderRadius: 10, backgroundColor: c.surface1 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "700" }}>{t(`내 결정 · ${human.length}건`, `My decisions · ${human.length}`)}</Text>
        {human.length === 0 && <Text style={{ color: c.foregroundMuted }}>{t("내 답을 기다리는 세션이 없습니다.", "No sessions are waiting for your decision.")}</Text>}
        {latestMoved && <ReceiptText receipt={latestMoved} theme={theme} />}
        {visible.map(card => <DecisionActions key={JSON.stringify([card.session.projectId, card.session.id, card.session.decision?.version])}
          card={card} theme={theme} coordinator={snapshot.coordinator} coordinatorTitle={snapshot.sessions.find(s => s.id === snapshot.coordinator)?.title}
          open={actions.onOpen} receipt={receipts.find(r => matches(r, card))}
          onSent={result => {
            setReceipts(prior => [result, ...prior.filter(r => !(r.projectId === result.projectId && r.sessionId === result.sessionId))].slice(0, 20));
            onRefresh();
          }} />)}
        {human.length > digestLimit && <Button theme={theme} label={t(`결정 ${human.length - digestLimit}건 더 보기`, `Show ${human.length - digestLimit} more decisions`)} onPress={() => setDigestLimit(human.length)} />}
      </View>}
      {!settings && snapshot && !projects.length && (configured || !snapshot.projects.length) && <Text style={{ color: c.foregroundMuted }}>{t("표시할 세션이 없습니다. 워크스페이스에서 세션을 시작하면 여기에 나타납니다.", "Start a session in a workspace to see it here.")}</Text>}
      {!settings && hostId && snapshot && <BoardHosts current={{ id: hostId, label: hostLabel }} settings={false} theme={theme} open={onOpenHostSession} />}
      {!settings && projects.length > 0 && <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 19, fontWeight: "700" }}>{t("프로젝트별 진행", "Project progress")}</Text>}
      {!settings && projects.map((p) => <Project key={p.id} title={p.title} cards={p.cards} compact={layout.compact} theme={theme} {...actions} />)}
    </ScrollView>
  );
}
