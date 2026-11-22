import { Text, View } from "react-native";
import type { ProviderEntry } from "../shared/dispatch";
import { recentUsage, type AccountUsage } from "../shared/usage-routing";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

export function UsageRouting({providers,reports,enabled,busy,onToggle,theme}:{
  providers:ProviderEntry[]; reports:AccountUsage[]; enabled:boolean; busy:boolean; onToggle:()=>void; theme:Theme;
}) {
  const {t,language} = useBoardLanguage();
  const c = theme.colors;
  const seen = new Set(reports.map(r=>r.providerId));
  const unknown = providers.filter(p=>!seen.has(p.id));
  const date = (value:string) => new Date(value).toLocaleString(language==="ko" ? "ko-KR" : "en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
  const number = (n:number) => n.toLocaleString(language==="ko" ? "ko-KR" : "en-US",{maximumFractionDigits:2});
  const reset = (value:string|null) => value ? t(` · ${date(value)} 초기화`,` · resets ${date(value)}`) : "";
  return <View style={{gap:7,padding:12,borderRadius:8,backgroundColor:c.surface1}}>
    <Text accessibilityRole="header" style={{color:c.foreground,fontWeight:"600"}}>{t("계정별 남은 사용량","Remaining account usage")}</Text>
    {reports.map((r,index)=>{
      const values = [
        ...r.windows.map(w=>w.label+" · "+(w.remainingPct===null ? t("미확인","Unknown") : number(w.remainingPct)+"%")+reset(w.resetsAt)),
        ...r.balances.map(b=>b.label+" · "+(b.remaining===null ? t("미확인","Unknown") : number(b.remaining)+" "+b.unit)+reset(b.resetsAt)),
      ];
      return <View key={r.providerId+":"+index} style={{gap:2}}>
        <Text selectable style={{color:c.foreground,fontWeight:"600"}}>{r.label}{r.plan ? " · "+r.plan : ""}</Text>
        <Text selectable style={{color:c.foregroundMuted}}>{r.status==="available" && values.length ? values.join("\n") : t("잔여량 미확인","Remaining quota unknown")}</Text>
        {r.fetchedAt && <Text style={{fontSize:12,color:c.foregroundMuted}}>{recentUsage(r) ? t("조회","Checked") : t("오래된 조회","Stale") } · {date(r.fetchedAt)}</Text>}
      </View>;
    })}
    {!!unknown.length && <Text selectable style={{color:c.foregroundMuted}}>{t("잔여량 미확인","Remaining quota unknown")} · {unknown.map(p=>p.label).join(", ")}</Text>}
    {!reports.length && !unknown.length && <Text style={{color:c.foregroundMuted}}>{t("호스트에 사용량 보고서가 없습니다.","This host has no usage reports.")}</Text>}
    <View style={{alignItems:"flex-start"}}>
      <Button theme={theme} selected={enabled} disabled={busy}
        label={enabled ? t("사용량 기반 자동 배정 켜짐","Usage-aware routing on") : t("사용량 기반 자동 배정 꺼짐","Usage-aware routing off")}
        onPress={onToggle}/>
    </View>
    <Text style={{fontSize:12,color:c.foregroundMuted}}>{t("자동 배정은 같은 등급에서 공통 한도가 있는 계정의 가장 낮은 잔여율을 비교합니다. 직접 저장한 배정 순서가 우선입니다.","Automatic routing compares the lowest fresh headroom for candidates with a shared quota window. Saved route priorities take precedence.")}</Text>
  </View>;
}
