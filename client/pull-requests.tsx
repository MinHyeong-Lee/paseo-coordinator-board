import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { setProjectRepository, type PullRequestView } from "../shared/prs";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

type PullRequest = PullRequestView["items"][number];
const labels = {
  ready: ["병합 검토 가능", "Ready for merge review"], draft: ["초안", "Draft"],
  conflict: ["충돌 해결 필요", "Conflicts to resolve"], "checks-failed": ["검사 실패", "Checks failed"],
  "checks-pending": ["검사 중", "Checks pending"], "changes-requested": ["수정 요청", "Changes requested"],
  blocked: ["병합 조건 대기", "Merge requirements pending"], unknown: ["상태 미확인", "Status unknown"],
  "auto-merge": ["자동 병합 대기", "Auto-merge enabled"],
} as const;

export function PullRequestCard({pr, theme, decision = false, openCoordinator}: {pr: PullRequest; theme: Theme; decision?: boolean; openCoordinator?: () => void}) {
  const {t} = useBoardLanguage();
  const [error, setError] = useState(false);
  const c = theme.colors;
  const open = async () => {
    try { await openExternalUrl(pr.url); setError(false); } catch { setError(true); }
  };
  return <View style={{gap: 5, borderTopColor: c.border, borderTopWidth: 1, paddingVertical: 8}}>
    <Text selectable style={{color: c.foregroundMuted, fontSize: 12}}>{pr.repo} #{pr.number} · {t(labels[pr.reason][0], labels[pr.reason][1])}</Text>
    <Text selectable style={{color: c.foreground, fontSize: 15, fontWeight: "600"}}>{pr.title}</Text>
    <View style={{flexDirection: "row", flexWrap: "wrap", gap: 6}}>
      <Button theme={theme} selected={decision} label={decision ? t("GitHub에서 병합 여부 검토", "Review merge on GitHub") : t("GitHub에서 PR 열기", "Open PR on GitHub")} onPress={() => void open()} />
      {decision && openCoordinator && <Button theme={theme} label={t("코디네이터 세션 열기", "Open coordinator session")}
        accessibilityLabel={pr.repo + " #" + pr.number + " · " + t("코디네이터 세션 열기", "Open coordinator session")} onPress={openCoordinator} />}
    </View>
    {error && <Text selectable style={{color:c.foregroundMuted}}>{pr.url}</Text>}
  </View>;
}

export function PullRequestSettings({view, names, theme, refresh}: {view: PullRequestView; names: Map<string,string>; theme: Theme; refresh: () => void}) {
  const {t} = useBoardLanguage();
  const [expanded, setExpanded] = useState(false);
  return <View style={{gap:8}}>
    <Button theme={theme} label={expanded ? t("GitHub 저장소 설정 닫기", "Close GitHub repositories") : t("프로젝트별 GitHub 저장소", "GitHub repositories by project")} onPress={() => setExpanded(!expanded)} />
    {expanded && view.projects.map(project => <RepositorySetting key={JSON.stringify([project.projectId, project.mode, project.repo])} project={project} title={names.get(project.projectId) ?? project.projectId} theme={theme} refresh={refresh}/>)}
  </View>;
}

function RepositorySetting({project, title, theme, refresh}: {project: PullRequestView["projects"][number]; title:string; theme:Theme; refresh:()=>void}) {
  const {t} = useBoardLanguage();
  const setRepo = useRpc(setProjectRepository);
  const [repo, setText] = useState(project.repo ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const c = theme.colors;
  async function change(mode: "auto"|"off"|"manual") {
    if (pending) return;
    setPending(true);
    try {
      await setRepo({projectId:project.projectId, mode, ...(mode === "manual" ? {repo:repo.trim()} : {}), expectedMode:project.mode, expectedRepo:project.repo});
      setError(false); refresh();
    } catch { setError(true); } finally { setPending(false); }
  }
  const states = {ok:t("조회됨","Connected"), unmapped:t("저장소 연결 필요","Link a repository"), unavailable:t("조회 실패 · 호스트의 gh 연결 확인","Lookup failed · Check gh on the host"), off:t("꺼짐","Off"), truncated:t("일부 PR만 표시","Showing a partial PR list")};
  return <View style={{gap:6,padding:10,backgroundColor:c.surface1,borderRadius:8}}>
    <Text selectable style={{color:c.foreground,fontWeight:"600"}}>{title}</Text>
    <Text selectable style={{color:c.foregroundMuted}}>{project.repo ? project.repo + " · " : ""}{states[project.status]}</Text>
    <TextInput accessibilityLabel={t(title+" GitHub 저장소",title+" GitHub repository")} placeholder="owner/repository" autoCapitalize="none" autoCorrect={false}
      value={repo} onChangeText={setText} placeholderTextColor={c.foregroundMuted} style={{color:c.foreground,borderColor:c.border,borderWidth:1,borderRadius:6,padding:7}}/>
    <View style={{flexDirection:"row",flexWrap:"wrap",gap:5}}>
      <Button theme={theme} label={t("저장소 연결", "Link repository")} disabled={pending || !repo.trim()} onPress={() => void change("manual")} />
      <Button theme={theme} selected={project.mode==="auto"} disabled={pending || project.mode==="auto"} label={t("자동 감지","Auto-detect")} onPress={() => void change("auto")}/>
      <Button theme={theme} selected={project.mode==="off"} disabled={pending || project.mode==="off"} label={t("PR 조회 끄기","Turn off PR lookup")} onPress={() => void change("off")}/>
    </View>
    {error && <Text accessibilityLiveRegion="polite" style={{color:c.statusDanger}}>{t("저장소 이름과 최신 프로젝트 설정을 확인해 주세요.","Check the repository name and refresh this project's settings.")}</Text>}
  </View>;
}
