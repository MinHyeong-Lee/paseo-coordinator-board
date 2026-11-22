import { useState, type ReactNode } from "react";
import { View, Pressable, Text, ScrollView } from "react-native";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { columnWidth, COLUMN_GAP } from "./lane-width";
import { PullRequestCard, type MergeNotice } from "./pull-requests";
import type { PullRequestItem } from "../shared/prs";
import type { TrackedDecision } from "../shared/tracked-decisions";
import { factStatus, laneLabel, noteLabel, sessionDetail, type Card, type Lane } from "./model";
type Actions = { sessionHostLabel?: string; onOpen?: (id:string) => void; onEdit:(id:string) => void };

function accent(lane: Lane, theme: Theme) {
  const c = theme.colors;
  if (lane === "human") return c.statusWarning;
  if (lane === "running") return c.accent;
  if (lane === "done") return c.statusSuccess;
  return c.foregroundMuted;
}

function CardView({ card, theme, onOpen, onEdit, sessionHostLabel }: { card: Card; theme: Theme } & Actions) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useBoardLanguage();
  const { session, note } = card;
  const c = theme.colors;
  const fact = session.boardFact;
  const question = session.decision?.question;
  const runtime = [session.provider, session.model === session.provider ? null : session.model].filter(Boolean).join(" / ");
  const noteText = note && note.kind !== "clear" ? [note.origin === "agent" ? t("세션 보고", "Session report") : null, noteLabel(note.kind, t), note.text].filter(Boolean).join(" · ") : null;
  return (
    <View style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0, gap: 6 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
        accessibilityLabel={t(`${session.title} · ${expanded ? "상세 접기" : "상세 보기"}`, `${session.title} · ${expanded ? "Hide details" : "View details"}`)}
        onPress={() => setExpanded(value => !value)} style={{ gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600", flex: 1 }}>{session.title}</Text>
          <Text accessible={false} style={{ color: c.foregroundMuted }}>{expanded ? "▴" : "▾"}</Text>
        </View>
        <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {card.lane === "human" ? t("내 답을 기다리는 중", "Waiting for my decision")
            : session.detail ? sessionDetail(session.detail, t) : laneLabel(card.lane, t)}
        </Text>
        {!!sessionHostLabel && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {t("실행 호스트", "Host")} · {sessionHostLabel}
        </Text>}
      </Pressable>
      {fact && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {fact.current ? "" : t("이전 · ", "Previous · ")}{factStatus(fact, t)}
      </Text>}
      {expanded && <>
        {fact && <View style={{ gap: 3 }}>
          <Text selectable style={{ color: c.foreground }}>{fact.answer}</Text>
          <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("확인 근거", "Source")} · {fact.source}</Text>
        </View>}
        <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{[session.sourceProjectTitle && t(`원래 소속 ${session.sourceProjectTitle}`, `From ${session.sourceProjectTitle}`), session.workspaceTitle, runtime].filter(Boolean).join(" · ")}</Text>
        {!!session.detail && <Text selectable style={{ color: c.foregroundMuted, fontSize: 13 }}>{sessionDetail(session.detail, t)}</Text>}
        {!!question && question !== session.detail && !session.detail.endsWith(" · " + question) && note?.text !== question &&
          <Text selectable style={{ color: c.foreground, fontSize: 13 }}>{question}</Text>}
        {noteText && <Text selectable style={{ color: c.foreground, fontSize: 13 }}>{noteText}</Text>}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
          {onOpen && <Button theme={theme} label={t("세션 열기", "Open session")} accessibilityLabel={t(`세션 열기 · ${session.title}`, `Open session · ${session.title}`)} onPress={() => onOpen(session.id)} />}
          <Button theme={theme} label={noteText ? t("기록 편집", "Edit note") : t("기록 추가", "Add note")} accessibilityLabel={t(`기록 편집 · ${session.title}`, `Edit note · ${session.title}`)} onPress={() => onEdit(session.id)} />
        </View>
      </>}
    </View>
  );
}

type Entry = {key:string; content: ReactNode};

function RecordPreview({item,theme,render}: {item:TrackedDecision;theme:Theme;render:(item:TrackedDecision)=>ReactNode}) {
  const [expanded,setExpanded] = useState(false);
  const {t} = useBoardLanguage();
  return <View style={{gap:4}}>
    <Button theme={theme} label={expanded ? t("결정 카드 접기","Hide decision card") : item.title}
      accessibilityLabel={t(`결정 카드 · ${item.title}`,`Decision card · ${item.title}`)} onPress={()=>setExpanded(v=>!v)} />
    {expanded && render(item)}
  </View>;
}

function Column({lane,entries,theme}: {lane:Lane;entries:Entry[];theme:Theme}) {
  const {t} = useBoardLanguage();
  const [limit,setLimit] = useState(4);
  const c=theme.colors;
  return <View style={{padding:8,borderRadius:8,backgroundColor:c.surface1,borderColor:c.border,borderWidth:1,gap:7}}>
    <View style={{flexDirection:"row",alignItems:"center",gap:6}}>
      <View style={{width:7,height:7,borderRadius:4,backgroundColor:accent(lane,theme)}} />
      <Text accessibilityRole="header" style={{color:c.foreground,flex:1,fontWeight:"600"}}>{laneLabel(lane,t)}</Text>
      <Text style={{color:c.foregroundMuted}}>{entries.length}</Text>
    </View>
    {entries.slice(0,limit).map(entry=><View key={entry.key}>{entry.content}</View>)}
    {entries.length>limit && <Button theme={theme} label={t(`결정·작업 ${entries.length-limit}개 더 보기`,`Show ${entries.length-limit} more items`)} onPress={()=>setLimit(n=>n+10)} />}
  </View>;
}

type Props = Actions & {projectId:string; title:string; decisions:number; cards:Card[]; records:TrackedDecision[]; requests:PullRequestItem[];
  renderRecord:(item:TrackedDecision)=>ReactNode; theme:Theme; compact:boolean; onMergeResult:(notice:MergeNotice)=>void};
const order:Lane[] = ["running","review","human","idle","done","unknown"];

export function Project({projectId,title,decisions,cards,records,requests,renderRecord,theme,compact,onMergeResult,...actions}:Props) {
  const {t} = useBoardLanguage();
  const [width,setWidth] = useState(0);
  const groups:Record<Lane,Entry[]> = {running:[],review:[],human:[],idle:[],done:[],unknown:[]};
  for(const item of records) {
    const since = Date.parse(item.since ?? "");
    const answered = item.replyHistory.some(reply => Date.parse(reply.at ?? "") >= since);
    const lane = answered && !item.matchedSessionId ? "review" : "human";
    groups[lane].push({key:"decision:"+item.key,content:<RecordPreview item={item} theme={theme} render={renderRecord} />});
  }
  for(const card of cards) {
    if(card.lane==="human" && records.some(item=>item.matchedSessionId===card.session.id)) continue;
    groups[card.lane].push({key:"session:"+card.session.id,content:<CardView card={card} theme={theme} {...actions} />});
  }
  for(const pr of requests) {
    if(records.some(item=>item.matchedPull?.repo===pr.repo && item.matchedPull.number===pr.number)) continue;
    const lane = pr.lane==="review" ? "human" : ["conflict","checks-failed","changes-requested","blocked","unknown"].includes(pr.reason) ? "review" : "running";
    groups[lane].push({key:pr.url,content:<PullRequestCard projectId={projectId} pr={pr} theme={theme} onResult={onMergeResult} />});
  }
  const lanes=order.filter(lane=>groups[lane].length);
  const stacked = width ? width<490 : compact;
  const running=cards.filter(card=>card.lane==="running").length;
  const columns=lanes.map(lane=><View key={lane} style={stacked ? {width:"100%"} : {width:columnWidth(width,lanes.length)}}>
    <Column lane={lane} entries={groups[lane]} theme={theme} />
  </View>);
  return <View style={{gap:8}} onLayout={e=>setWidth(e.nativeEvent.layout.width)}>
    <Text accessibilityRole="header" style={{fontSize:18,fontWeight:"600",color:theme.colors.foreground}}>{title}</Text>
    <Text style={{fontSize:13,color:theme.colors.foregroundMuted}}>
      {t(`세션 ${cards.length}개 · 진행 중 ${running} · 내 결정 ${decisions}건`,`Sessions ${cards.length} · In progress ${running} · My decisions ${decisions}`)}
    </Text>
    {stacked ? <View style={{gap:COLUMN_GAP}}>{columns}</View> :
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{gap:COLUMN_GAP,paddingBottom:5,alignItems:"flex-start"}}>{columns}</ScrollView>}
  </View>;
}
