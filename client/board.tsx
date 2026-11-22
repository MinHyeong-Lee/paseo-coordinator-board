import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { BoardHosts } from "./hosts";
import { OperationsPanel } from "./operations";
import { Button, type Theme } from "./controls";
import { columnWidth, COLUMN_GAP } from "./lane-width";
import { labels, lanes, noteLabels, projectCards, type Card, type Lane, type Snapshot } from "./model";

type Actions = { coordinator?: string | null; onCoordinator?: (id: string | null) => void; changing?: boolean; onOpen?: (id: string) => void; onEdit: (id: string) => void };

function accent(lane: Lane, theme: Theme) {
  const c = theme.colors;
  if (lane === "human") return c.statusWarning;
  if (lane === "running") return c.accent;
  if (lane === "done") return c.statusSuccess;
  return c.foregroundMuted;
}

function CardView({ card, theme, onOpen, onEdit }: { card: Card; theme: Theme } & Actions) {
  const { session, note } = card;
  const c = theme.colors;
  const runtime = [session.provider, session.model === session.provider ? null : session.model].filter(Boolean).join(" / ");
  const noteText = note && note.kind !== "clear" ? [note.origin === "agent" ? "세션 보고" : null, noteLabels[note.kind], note.text].filter(Boolean).join(" · ") : null;
  return (
    <View style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0, gap: 6 }}>
      <Text selectable style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>{session.title}</Text>
      <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{[session.workspaceTitle, runtime].filter(Boolean).join(" · ")}</Text>
      {!!session.detail && <Text selectable style={{ color: c.foregroundMuted, fontSize: 13 }}>{session.detail}</Text>}
      {noteText && <Text selectable numberOfLines={3} style={{ color: c.foreground, fontSize: 13 }}>{noteText}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
        {onOpen && <Button theme={theme} label="세션 열기" accessibilityLabel={`세션 열기 · ${session.title}`} onPress={() => onOpen(session.id)} />}
        <Button theme={theme} label={noteText ? "기록 편집" : "기록 추가"} accessibilityLabel={`기록 편집 · ${session.title}`} onPress={() => onEdit(session.id)} />
      </View>
    </View>
  );
}

function Column({ lane, cards, theme, ...actions }: { lane: Lane; cards: Card[]; theme: Theme } & Actions) {
  const [limit, setLimit] = useState(4);
  const c = theme.colors;
  return (
    <View style={{ padding: 8, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: accent(lane, theme) }} />
        <Text style={{ flex: 1, color: c.foreground, fontSize: 14, fontWeight: "600" }}>{labels[lane]}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{cards.length}</Text>
      </View>
      {cards.slice(0, limit).map((card) => <CardView key={card.session.id} card={card} theme={theme} {...actions} />)}
      {cards.length > limit && <Button theme={theme} label={`${cards.length - limit}개 중 더 보기`} onPress={() => setLimit((n) => n + 10)} />}
    </View>
  );
}

function Project({ cards, title, theme, compact, ...actions }: { cards: Card[]; title: string; theme: Theme; compact: boolean } & Actions) {
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
      {narrow ? <>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
          {lanes.map((lane) => <Button theme={theme} key={lane} selected={lane === current} label={`${labels[lane]} ${grouped[lane].length}`} onPress={() => setSelected(lane)} />)}
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
  const { human, projects } = useMemo(() => snapshot ? projectCards(snapshot) : { human: [], projects: [] }, [snapshot]);
  const [settings, setSettings] = useState(false);
  const [manage, setManage] = useState(false);
  const [pickSession, setPickSession] = useState(false);
  const configured = snapshot?.projects?.some(p => p.selected);
  const pickingProjects = !configured || (!settings && !snapshot?.coordinator);
  const [digestLimit, setDigestLimit] = useState(5);
  const c = theme.colors;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ gap: 20, padding: layout.compact ? 12 : 22 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <View style={{ flex: 1, minWidth: 140, gap: 3 }}>
          <Text style={{ color: c.foreground, fontSize: 22, fontWeight: "700" }} accessibilityRole="header">{settings ? "코디네이터 보드 설정" : "세션별 코디네이터 보드"}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{[hostLabel, updatedAt && `${updatedAt.toLocaleTimeString("ko-KR")} 갱신`].filter(Boolean).join(" · ")}</Text>
        </View>
        {!settings && <Button theme={theme} label={loading ? "조회 중…" : "새로 고침"} onPress={onRefresh} disabled={loading} />}
        <Button theme={theme} label={settings ? "보드로 돌아가기" : "설정"} onPress={() => {
          setSettings(!settings); setManage(false); setPickSession(false);
        }} />
      </View>
      {!!error && <Text accessibilityLiveRegion="polite" style={{ color: c.statusDanger }}>세션 조회 실패 · {error}{snapshot ? " · 마지막으로 받은 결과를 표시합니다." : ""}</Text>}
      {!!error && settings && <Button theme={theme} label="세션 다시 조회" disabled={loading} onPress={onRefresh} />}
      {snapshot && onProject && (pickingProjects || settings) && <View style={{ gap: 7 }}>
        {!pickingProjects
          ? <Button theme={theme} label={manage ? "프로젝트 관리 닫기" : "관리 프로젝트 변경"} onPress={() => setManage(!manage)} />
          : <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }}>다이제스트에서 관리할 프로젝트 선택</Text>}
        {(pickingProjects || manage) && <>
          <Text style={{ color: c.foregroundMuted }}>선택한 프로젝트의 최근 대화를 읽어 내 결정을 찾습니다. 코디네이터를 지정하면 그 세션도 선택한 프로젝트의 발췌를 볼 수 있습니다.</Text>
          {snapshot.projects.map(p => <Button key={p.id} theme={theme} selected={p.selected} disabled={actions.changing}
            label={`${p.selected ? "관리에서 제외" : "추가"} · ${p.title}${snapshot.projects.some(x => x.id !== p.id && x.title === p.title) ? " · " + (p.path || p.id) : ""}`}
            onPress={() => onProject(p.id, !p.selected)} />)}
        </>}
      </View>}
      {settings && hostId && <BoardHosts current={{ id: hostId, label: hostLabel }} settings theme={theme} open={onOpenHostSession} />}
      {snapshot && <OperationsPanel settings={settings} theme={theme} coordinator={snapshot.coordinator} configured={!!configured}
        refreshBoard={onRefresh} openCoordinator={actions.onOpen} />}
      {settings && snapshot && actions.onCoordinator && <View style={{ gap: 8 }}>
        <Button theme={theme} label={pickSession ? "기존 세션 목록 닫기" : "기존 세션에서 코디네이터 지정"} onPress={() => setPickSession(!pickSession)} />
        {pickSession && <>
          {snapshot.coordinator && <Button theme={theme} disabled={actions.changing} label="현재 코디네이터 지정 해제" onPress={() => actions.onCoordinator?.(null)} />}
          {snapshot.sessions.filter(s => s.id !== snapshot.coordinator).map(s => <Button key={s.id} theme={theme} disabled={actions.changing}
            label={`${s.projectTitle} · ${s.title} · 지정`} onPress={() => actions.onCoordinator?.(s.id)} />)}
          {!snapshot.sessions.length && <Text style={{ color: c.foregroundMuted }}>관리할 프로젝트를 선택하면 지정할 수 있는 세션이 표시됩니다.</Text>}
        </>}
      </View>}
      {!settings && snapshot && configured && <View style={{ gap: 10, padding: 14, borderWidth: 1, borderColor: human.length ? c.statusWarning : c.border, borderRadius: 10, backgroundColor: c.surface1 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "700" }}>내 결정 · {human.length}건</Text>
        {human.length === 0 && <Text style={{ color: c.foregroundMuted }}>내 답을 기다리는 세션이 없습니다.</Text>}
        {human.slice(0, digestLimit).map(({ session, note }) => {
          const question = note?.kind === "question" ? note.text : null;
          const summary = [session.lane === "human" && session.detail, question].filter(Boolean).join(" · ");
          return (
            <Pressable key={session.id} accessibilityRole="button" accessibilityLabel={`${session.projectTitle} · ${session.title} · ${summary}`}
              onPress={() => actions.onOpen ? actions.onOpen(session.id) : actions.onEdit(session.id)}
              style={({ pressed }) => ({ paddingTop: 8, borderTopWidth: 1, borderColor: c.border, opacity: pressed ? 0.7 : 1, gap: 3 })}>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{session.projectTitle} · {session.title}</Text>
              <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>{summary || "세션에서 결정을 확인하세요."}</Text>
            </Pressable>
          );
        })}
        {human.length > digestLimit && <Button theme={theme} label={`결정 ${human.length - digestLimit}건 더 보기`} onPress={() => setDigestLimit(human.length)} />}
      </View>}
      {!settings && snapshot && !projects.length && (configured || !snapshot.projects.length) && <Text style={{ color: c.foregroundMuted }}>표시할 세션이 없습니다. 워크스페이스에서 세션을 시작하면 여기에 나타납니다.</Text>}
      {!settings && hostId && <BoardHosts current={{ id: hostId, label: hostLabel }} settings={false} theme={theme} open={onOpenHostSession} />}
      {!settings && projects.map((p) => <Project key={p.id} title={p.title} cards={p.cards} compact={layout.compact} theme={theme} {...actions} />)}
    </ScrollView>
  );
}
