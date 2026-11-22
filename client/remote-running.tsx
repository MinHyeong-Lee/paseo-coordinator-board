import { getPaseoClient, useHosts, useSettings } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { boardHosts, hostVisibility, type BoardHost } from "../shared/hosts";
import { readRemoteSessions, remoteScope, type LocalProject, type RemoteScope, type RemoteSession, type Repository } from "./remote-sessions";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

type Open = (serverId: string, sessionId: string) => void;
type Props = {current: {id:string;label:string}; projects:LocalProject[]; repositories:Repository[]; theme:Theme; open?:Open};

export function RemoteRunning({ current, projects, repositories, theme, open }: Props) {
  const hosts = useHosts();
  const visibility = useSettings(hostVisibility);
  if (visibility.status !== "ready" || !projects.some(p => p.selected)) return null;
  const scope = remoteScope(projects, repositories);
  const key = JSON.stringify(scope);
  const registered = boardHosts(current,hosts).filter(host => host.serverId !== current.id &&
    host.status === "online" && !visibility.values.hidden.includes(host.serverId));
  return <>{registered.map(host => <HostRunning key={JSON.stringify([host.serverId,key])} host={host} scope={scope}
    projects={projects} theme={theme} open={open} />)}</>;
}

function HostRunning({ host, scope, projects, theme, open }: {host:BoardHost;scope:RemoteScope;projects:LocalProject[];theme:Theme;open?:Open}) {
  const {t} = useBoardLanguage();
  const [rows,setRows] = useState<RemoteSession[]>([]);
  const [failed,setFailed] = useState(false);
  const c = theme.colors;
  // The parent remounts this host whenever its project or repository scope changes.
  useEffect(() => {
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending || !active) return;
      pending = true;
      try {
        const next = await readRemoteSessions(getPaseoClient(host.serverId), scope, () => active);
        if (active) { setRows(next); setFailed(false); }
      } catch {
        if (active) { setRows([]); setFailed(true); }
      } finally { pending=false; }
    }
    void refresh();
    const timer=setInterval(() => void refresh(),30_000);
    return () => {active=false;clearInterval(timer);};
  }, []);
  if (failed) return <Text style={{color:c.foregroundMuted}}>{t(`${host.label} · 진행 중인 세션 조회 실패`,`${host.label} · Could not load running sessions`)}</Text>;
  if (!rows.length) return null;
  return <View style={{gap:6,borderWidth:1,borderColor:c.border,borderRadius:10,padding:12}}>
    <Text accessibilityRole="header" style={{color:c.foreground,fontWeight:"600"}}>{t(`${host.label} · 진행 중인 세션`,`${host.label} · Running sessions`)}</Text>
    {rows.map(row => {
      const project = projects.find(p => p.id===row.projectId);
      if (!project?.selected) return null;
      const title = row.title || t(`세션 ${row.sessionId.slice(0,8)}`,`Session ${row.sessionId.slice(0,8)}`);
      return <View key={row.sessionId} style={{flexDirection:"row",flexWrap:"wrap",alignItems:"center",gap:6}}>
        <Text selectable style={{flexGrow:1,flexShrink:1,color:c.foreground}}>{project.title} · {title}</Text>
        {open && <Button theme={theme} label={t("담당 세션 열기","Open task session")}
          accessibilityLabel={t(`${host.label} · ${title} 열기`,`Open ${title} on ${host.label}`)} onPress={() => open(host.serverId,row.sessionId)} />}
      </View>;
    })}
  </View>;
}
