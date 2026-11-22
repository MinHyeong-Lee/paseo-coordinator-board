import { useState } from "react";
import { Text, View } from "react-native";
import type { ReplyEntry } from "../shared/reply-history";
import { Button, SessionChip, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

type Props = { entry: ReplyEntry; theme: Theme; open?: (id:string) => void };
export function ReplyCard({entry, theme, open}:Props) {
  const {t,language} = useBoardLanguage();
  const colors = theme.colors;
  const [full,setFull] = useState(false);
  const long = [entry.answer,entry.response].some(text => text && (text.length > 160 || text.split("\n").length > 3));
  const status = {
    sent:t("전송됨","Sent"), pending:t("전송 확인 중","Delivery unconfirmed"),
    recorded:t("보드에 기록함","Saved on board"), closed:t("기록 닫음","Record closed"),
  }[entry.status];
  const states = {running:t("진행 중","Running"), idle:t("대기 중","Idle"), closed:t("대화 종료","Closed"),
    error:t("오류","Error"), unknown:t("미확인","Unknown")};
  const date = new Date(entry.at).toLocaleString(language === "ko" ? "ko-KR" : "en-US",
    {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"});
  const recipient = entry.recipientTitle ?? (entry.coordinator ? t("코디네이터","Coordinator") : entry.recipientId);
  return <View style={{gap:5,padding:9,borderRadius:7,backgroundColor:colors.surface0,borderWidth:1,borderColor:colors.border}}>
    <Text selectable style={{fontWeight:"600",color:colors.foreground}}>{entry.title}</Text>
    <Text selectable style={{color:colors.foregroundMuted,fontSize:12}}>{[status, date, recipient].filter(Boolean).join(" · ")}</Text>
    {!!entry.answer && <Text selectable numberOfLines={full ? undefined : 3} style={{color:colors.foreground}}>{entry.answer}</Text>}
    {entry.status === "sent" && (entry.response
      ? <Text selectable numberOfLines={full ? undefined : 3} style={{color:colors.foreground}}>{t("세션의 후속 응답","Session follow-up")} · {entry.response}</Text>
      : <Text style={{color:colors.foregroundMuted,fontSize:12}}>{t("후속 응답 미확인","No verified follow-up yet")}</Text>)}
    {long && <Button theme={theme} expanded={full} label={full ? t("접기","Show less") : t("내용 펼치기","Read more")} onPress={()=>setFull(value=>!value)} />}
    {entry.recipientId && entry.canOpen && open && <SessionChip theme={theme}
      label={[t("받은 세션","Recipient session"),entry.recipientState && states[entry.recipientState]].filter(Boolean).join(" · ")}
      accessibilityLabel={t(`받은 세션 열기 · ${entry.title}`,`Open recipient session · ${entry.title}`)} onPress={()=>open(entry.recipientId!)} />}
  </View>;
}

export function ReplyHistory({entries,theme,open}:{entries:ReplyEntry[];theme:Theme;open?:Props["open"]}) {
  const {t} = useBoardLanguage();
  const [limit,setLimit] = useState(1);
  if (!entries.length) return null;
  return <View style={{gap:6}}>
    <Text accessibilityRole="header" style={{color:theme.colors.foreground,fontSize:15,fontWeight:"600"}}>{t("최근 결정 기록","Recent decision activity")} · {entries.length}</Text>
    {entries.slice(0, limit).map(entry=><ReplyCard key={entry.key} entry={entry} open={open} theme={theme} />)}
    {entries.length > limit && <Button theme={theme} label={t("이전 기록 더 보기","Show earlier activity")} onPress={()=>setLimit(n=>n+10)} />}
  </View>;
}
