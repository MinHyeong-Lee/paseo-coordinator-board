import { getPaseoClient, useHosts, useSettings } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { boardHosts, hiddenAfter, hostVisibility, type BoardHost } from "../shared/hosts";
import { Button, type Theme } from "./controls";

const statusText = {
  online: "연결됨", connecting: "연결 중", idle: "연결 대기", offline: "연결 끊김", error: "연결 오류", unknown: "연결 미확인",
};
const wrap = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };
type Open = (serverId: string, agentId: string) => void;

export function BoardHosts({ current, settings, theme, open }: {
  current: { id: string; label: string }; settings: boolean; theme: Theme; open?: Open;
}) {
  const registered = useHosts();
  const scope = useSettings(hostVisibility);
  const hosts = boardHosts(current, registered);
  const [expanded, setExpanded] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const pending = useRef(false);
  const [conflict, setConflict] = useState(false);
  const c = theme.colors;
  const ready = scope.status === "ready";
  const shown = ready ? hosts.filter(h => !scope.values.hidden.includes(h.serverId)) : [];
  const target = shown.find(h => h.serverId === chosen);
  const error = scope.status === "error" || scope.status === "invalid" || !!scope.saveError || conflict;

  async function change(id: string, show: boolean) {
    if (scope.status !== "ready" || pending.current) return;
    pending.current = true;
    try {
      setConflict(false);
      const saved = await scope.save({ hidden: hiddenAfter(scope.values.hidden, id, show) }, scope.revision);
      if (!saved) {
        await scope.reload();
        setConflict(true);
      }
      if (saved && !show && chosen === id) setChosen(null);
    } finally {
      pending.current = false;
    }
  }

  if (!settings && !expanded) {
    return <View style={wrap}><Button theme={theme} label="기기별 세션 찾아보기" onPress={() => setExpanded(true)} /></View>;
  }
  return <View style={{ gap: 8, padding: 14, borderRadius: 10, backgroundColor: c.surface1 }}>
    <View style={{ ...wrap, alignItems: "center", justifyContent: "space-between" }}>
      <Text accessibilityRole="header" style={{ fontSize: 17, fontWeight: "600", color: c.foreground }}>
        {settings ? "Paseo 호스트" : "기기별 세션"}
      </Text>
      {settings
        ? <Text style={{ color: c.foregroundMuted }}>앱에 등록 {registered.length}대</Text>
        : <Button theme={theme} label="기기별 세션 닫기" onPress={() => { setExpanded(false); setChosen(null); }} />}
    </View>
    {settings && <Text style={{ color: c.foregroundMuted }}>앱에 등록한 호스트는 기기별 세션에 기본으로 표시됩니다. 이 설정은 기기별 세션 목록에만 적용됩니다.</Text>}
    {scope.status === "loading" && <Text style={{ color: c.foregroundMuted }}>표시할 호스트를 확인하고 있습니다.</Text>}
    {error && <View style={wrap}>
      <Text accessibilityLiveRegion="polite" style={{ color: c.statusDanger }}>{ready ? "표시 설정을 저장하지 못했습니다. 최신 설정에서 다시 선택해 주세요." : "호스트 표시 설정을 읽지 못했습니다."}</Text>
      <Button theme={theme} label="호스트 표시 설정 다시 읽기" onPress={() => { setConflict(false); void scope.reload(); }} />
    </View>}
    {settings && ready && hosts.map(host => {
      const included = !scope.values.hidden.includes(host.serverId);
      return <View key={host.serverId} style={{ ...wrap, alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderColor: c.border, paddingTop: 7 }}>
        <Text style={{ flexShrink: 1, color: c.foreground }}>{host.label}{host.serverId === current.id ? " · 현재 보드" : ""} · {statusText[host.status]}</Text>
        <Button theme={theme} selected={included} disabled={scope.saving}
          label={included ? "기기별 세션에 표시" : "기기별 세션에서 숨김"}
          accessibilityLabel={host.label + (included ? " · 기기별 세션에서 숨기기" : " · 기기별 세션에 표시하기")}
          onPress={() => void change(host.serverId, !included)} />
      </View>;
    })}
    {!settings && ready && <>
      <View style={wrap}>
        {shown.map(host => <Button theme={theme} key={host.serverId} selected={host.serverId === target?.serverId}
          label={host.label + " · " + statusText[host.status]} disabled={host.status !== "online"}
          onPress={() => setChosen(host.serverId)} />)}
      </View>
      {!shown.length && <Text style={{ color: c.foregroundMuted }}>표시할 호스트가 없습니다. 설정에서 기기별 세션에 표시할 호스트를 고르세요.</Text>}
      {target?.status === "online" && <HostSessions key={target.serverId} host={target} theme={theme} open={open} />}
    </>}
  </View>;
}

type Summary = { id: string; title: string; project: string };
function HostSessions({ host, theme, open }: { host: BoardHost; theme: Theme; open?: Open }) {
  const [rows, setRows] = useState<Summary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const seen = useRef(new Set<string>());
  const busy = useRef(false);
  const c = theme.colors;

  const load = useCallback(async (next?: string) => {
    if (busy.current) return;
    busy.current = true;
    const token = ++request.current;
    setLoading(true); setError(false);
    try {
      const client = getPaseoClient(host.serverId);
      const page = await client.agents.list({
        filter: { includeArchived: false, includeBackground: true },
        sort: [{ key: "created_at", direction: "desc" }], page: { limit: 20, cursor: next },
      });
      if (token !== request.current) return;
      const mapped = page.entries.filter(({ agent }) => !agent.archivedAt && !agent.internal)
        .map(({ agent, project }) => ({ id: agent.id, title: agent.title?.trim() || `세션 ${agent.id.slice(0, 8)}`, project: project.projectName || "" }));
      const visited = next ? new Set(seen.current).add(next) : new Set<string>();
      if (page.pageInfo.hasMore && (!page.pageInfo.nextCursor || visited.has(page.pageInfo.nextCursor))) throw Error();
      seen.current = visited;
      setRows(prior => [...new Map([...(next ? prior : []), ...mapped].map(row => [row.id, row])).values()]);
      setCursor(page.pageInfo.hasMore ? page.pageInfo.nextCursor : null);
    } catch {
      if (token === request.current) setError(true);
    } finally {
      if (token === request.current) { busy.current = false; setLoading(false); }
    }
  }, [host.serverId]);

  useEffect(() => {
    void load();
    return () => { request.current++; busy.current = false; };
  }, [load]);

  return <View style={{ gap: 6 }}>
    <View style={{ ...wrap, alignItems: "center", justifyContent: "space-between" }}>
      <Text style={{ fontWeight: "600", color: c.foreground }}>{host.label}의 세션</Text>
      <Button theme={theme} label="호스트 세션 새로 고침" disabled={loading} onPress={() => void load()} />
    </View>
    {rows.map(row => <View key={row.id} style={{ ...wrap, alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderColor: c.border, paddingTop: 6 }}>
      <Text style={{ flexShrink: 1, color: c.foreground }}>{[row.project, row.title].filter(Boolean).join(" · ")}</Text>
      {open && <Button theme={theme} label="세션 열기" accessibilityLabel={`${host.label} · ${row.title} 열기`} onPress={() => open(host.serverId, row.id)} />}
    </View>)}
    {loading && <Text style={{ color: c.foregroundMuted }}>세션을 읽고 있습니다.</Text>}
    {!loading && error && <Text accessibilityLiveRegion="polite" style={{ color: c.statusDanger }}>이 호스트에서 세션을 읽지 못했습니다. 연결 상태를 확인해 주세요.</Text>}
    {!loading && !error && !rows.length && !cursor && <Text style={{ color: c.foregroundMuted }}>표시할 세션이 없습니다.</Text>}
    {!loading && (cursor || error) && <View style={wrap}>
      <Button theme={theme} label={error ? "호스트 세션 다시 읽기" : "세션 더 보기"} onPress={() => void load(cursor ?? undefined)} />
    </View>}
  </View>;
}
