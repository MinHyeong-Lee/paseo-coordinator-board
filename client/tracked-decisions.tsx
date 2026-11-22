import { TextInput } from "@getpaseo/plugin/client/ui";
import { useRpc } from "@getpaseo/plugin/client";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { resolveTrackedDecision, type TrackedDecision } from "../shared/tracked-decisions";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

type Resolution = "closed" | "already-closed" | "changed" | "out-of-scope" | "unavailable";
type Props = {
  item: TrackedDecision; theme: Theme; open?: () => void; children?: ReactNode;
  onResolved: (result: Resolution) => Promise<void> | void;
};
const kinds = {
  check: ["확인", "Check"], answer: ["질문", "Question"], merge: ["병합 검토", "Merge review"],
  approve: ["승인 검토", "Approval review"], cleanup: ["정리", "Follow-up"], other: ["결정", "Decision"],
} as const;
const messages = {
  closed: ["결정 기록을 닫았습니다.", "Decision record closed."],
  "already-closed": ["이미 닫힌 결정 기록입니다.", "This decision record was already closed."],
  changed: ["기록 내용이 바뀌었습니다. 새로 고친 내용을 확인해 주세요.", "The record changed. Review its latest details."],
  "out-of-scope": ["현재 보드의 관리 대상에서 제외된 기록입니다.", "This record is outside the board’s current scope."],
  unavailable: ["기록 상태를 확인할 수 없습니다. 보드를 새로 고쳐 주세요.", "Could not confirm the record’s status. Refresh the board."],
} as const;
const wrap = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };

function Lines({ title, lines, theme }: { title: string; lines: readonly string[]; theme: Theme }) {
  if (!lines.length) return null;
  return <View style={{ gap: 3 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{title}</Text>
    {lines.map((line, index) => <Text key={index} selectable style={{ color: theme.colors.foreground }}>{line}</Text>)}
  </View>;
}

export function TrackedDecisionCard(props: Props) {
  return <DecisionRecord key={JSON.stringify([props.item.key, props.item.fingerprint])} {...props} />;
}

function DecisionRecord({ item, theme, open, onResolved, children }: Props) {
  const { t } = useBoardLanguage();
  const resolve = useRpc(resolveTrackedDecision);
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [skipped, setSkipped] = useState<Record<number, boolean>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Record<number, number[]>>({});
  const [result, setResult] = useState<Resolution | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const c = theme.colors;
  const words = kinds[item.kind];
  const headline = item.ask[0] || item.questions[0]?.text || item.recommend[0];
  const source = item.projectTitle || item.projectId;
  const where = item.where === "human" ? t("직접 처리", "Your action")
    : item.where === "session" ? t("담당 세션", "Assigned session")
    : item.where === "manager" ? t("코디네이터", "Coordinator") : null;
  const named = (label: string) => ({ label, accessibilityLabel: item.title + " · " + label });
  const isClosed = result === "closed" || result === "already-closed";
  const needsRefresh = result === "changed" || result === "out-of-scope" || result === "unavailable";
  const replies = item.questions.map((question, index) => {
    if (skipped[index]) return "";
    if (!question.options.length) return typed[index]?.trim() ?? "";
    return question.options.filter((_, choice) => selected[index]?.includes(choice)).map(option => option.key + " · " + option.text).join(", ");
  });
  const outstanding = replies.some((value, index) => !value && !skipped[index]);
  const answers = replies.flatMap((value, index) => {
    const question = item.questions[index];
    return value ? [[question.id, question.text].filter(Boolean).join(" · ") + " — " + value] : [];
  });
  const answer = answers.length ? [item.answerLead, ...answers].filter(Boolean).join("\n") : "";
  const tooLong = answer.length > 4000;

  function choose(index: number, choice: number, multi: boolean) {
    setConfirming(false); setSkipped(previous => ({ ...previous, [index]: false }));
    setSelected(previous => {
      const group = previous[index] ?? [];
      const next = multi ? group.includes(choice) ? group.filter(value => value !== choice) : [...group, choice] : [choice];
      return { ...previous, [index]: next };
    });
  }
  function skip(index: number) {
    setConfirming(false); setSkipped(previous => ({ ...previous, [index]: !previous[index] }));
    setSelected(previous => ({ ...previous, [index]: [] }));
    setTyped(previous => ({ ...previous, [index]: "" }));
  }
  async function refreshRecord() {
    if (pending.current || !result) return;
    pending.current = true; setBusy(true);
    try { await onResolved(result); setRefreshFailed(false); setResult(null); }
    catch { setRefreshFailed(true); }
    finally { pending.current = false; setBusy(false); }
  }
  async function acknowledge() {
    if (pending.current || !confirming || isClosed || needsRefresh || outstanding || tooLong) return;
    pending.current = true; setBusy(true);
    let status: Resolution;
    try {
      const response = await resolve({ source: item.source, projectId: item.projectId, id: item.id, fingerprint: item.fingerprint, ...(answer ? {answer} : {}) });
      status = response.status;
    } catch { status = "unavailable"; }
    setResult(status); setConfirming(false);
    try { await onResolved(status); } catch { setRefreshFailed(true); }
    finally { pending.current = false; setBusy(false); }
  }

  return <View style={{ paddingVertical: 10, gap: 7, borderTopWidth: 1, borderTopColor: c.border }}>
    <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{[source || t("보드 공통", "Board-wide"), t(words[0], words[1]), where, item.owner].filter(Boolean).join(" · ")}</Text>
    <Text accessibilityRole="header" selectable style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>{item.title}</Text>
    {!!headline && headline !== item.title && <Text selectable numberOfLines={expanded ? undefined : 2} style={{ color: c.foreground }}>{headline}</Text>}
    {item.kind === "merge" && item.mergeTarget && !item.matchedPull && <Text style={{ color: c.foregroundMuted }}>
      {t("현재 병합 검토 목록에 없습니다. 아래에 남은 질문을 확인하세요.", "This pull request is outside the current merge review list. Check any remaining questions below.")}
    </Text>}
    {children}
    <View style={wrap}>
      <Button theme={theme} {...named(expanded ? t("결정 상세 접기", "Hide decision details") : t("결정 상세 보기", "View decision details"))}
        onPress={() => setExpanded(value => !value)} />
      {open && <Button theme={theme} {...named(t("연결된 세션 열기", "Open linked session"))} onPress={open} />}
    </View>
    {expanded && <View style={{ gap: 10, padding: 10, backgroundColor: c.surface0, borderRadius: 7 }}>
      {!!item.since && <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {t("기록 시각", "Recorded at")} · {item.since}
      </Text>}
      <Lines theme={theme} title={t("요청한 일", "Requested action")} lines={item.ask.filter(line => line !== headline)} />
      <Lines theme={theme} title={t("추천", "Recommendation")} lines={item.recommend.filter(line => line !== headline)} />
      <Lines theme={theme} title={t("진행 단계", "Steps")} lines={item.steps} />
      <Lines theme={theme} title={t("근거", "Evidence")} lines={item.why} />
      <Lines theme={theme} title={t("위험", "Risks")} lines={item.risk} />
      {item.questions.map((question, index) => <View key={index} style={{ gap: 6 }}>
        <Text selectable style={{ color: c.foreground, fontWeight: "600" }}>{question.text}</Text>
        {!!question.options.length && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {question.multi ? t("여러 개 선택", "Choose any that apply") : t("하나 선택", "Choose one")}
        </Text>}
        {question.options.map((option, choice) => {
          const checked = selected[index]?.includes(choice) ?? false;
          const title = option.key + " · " + option.text;
          return <Pressable key={choice} accessibilityRole={question.multi ? "checkbox" : "radio"}
            accessibilityLabel={item.title + " · " + question.text + " · " + title} accessibilityState={{ checked, disabled: busy }} aria-checked={checked} disabled={busy}
            onPress={() => choose(index, choice, question.multi)}
            style={{ gap: 4, padding: 8, borderWidth: 1, borderRadius: 7, borderColor: checked ? c.accent : c.border, backgroundColor: checked ? c.surface2 : c.surface0 }}>
            <Text style={{ color: c.foreground, fontWeight: checked ? "700" : "500" }}>
              {checked ? "✓ " : ""}{title}{option.recommended ? " · " + t("추천", "Recommended") : ""}
            </Text>
            {!!option.note && <Text style={{ color: c.foregroundMuted }}>{option.note}</Text>}
            {([ [t("고르면", "Outcome"), option.does], [t("장점", "Benefits"), option.pros], [t("대가", "Trade-offs"), option.cons] ] as const)
              .map(([label, text]) => text ? <Text key={label} style={{ color: c.foregroundMuted, fontSize: 12 }}>{label} · {text}</Text> : null)}
          </Pressable>;
        })}
        {!question.options.length && !skipped[index] && <TextInput value={typed[index] ?? ""} editable={!busy} multiline maxLength={4000}
          accessibilityLabel={item.title + " · " + question.text + " · " + t("기록할 답", "Answer to record")}
          onChangeText={text => { setConfirming(false); setTyped(previous => ({ ...previous, [index]: text })); }}
          placeholder={t("기록할 답", "Answer to record")} placeholderTextColor={c.foregroundMuted}
          style={{ color: c.foreground, padding: 8, borderColor: c.border, borderWidth: 1, borderRadius: 6 }} />}
        <View style={wrap}><Button theme={theme} label={skipped[index] ? t("건너뛰기 취소", "Undo skip") : t("이 질문 건너뛰기", "Skip this question")}
          accessibilityLabel={item.title + " · " + question.text + " · " + t("건너뛰기", "Skip")} selected={!!skipped[index]}
          disabled={busy} onPress={() => skip(index)} /></View>
      </View>)}
      {!!answer && <Lines theme={theme} title={t("기록할 답", "Answers to record")} lines={[answer]} />}
      {tooLong && <Text style={{ color: c.statusWarning }}>{t("기록할 답을 4,000자 이내로 줄여 주세요.", "Shorten the answers to 4,000 characters.")}</Text>}
      {!!item.howToAnswer && <Lines theme={theme} title={t("답하는 방법", "How to respond")} lines={[item.howToAnswer]} />}
      {!!item.qa.length && <View style={{ gap: 5 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("이전 문답", "Question history")}</Text>
        {item.qa.map((entry, i) => <View key={i} style={{ gap: 3 }}>
          <Text selectable style={{ color: c.foreground }}>{[t("질문", "Question"), entry.askedAt, entry.q].filter(Boolean).join(" · ")}</Text>
          <Text selectable style={{ color: c.foregroundMuted }}>{entry.a ? [t("답", "Answer"), entry.answeredAt, entry.a].filter(Boolean).join(" · ") : t("답변 대기", "Awaiting reply")}</Text>
        </View>)}
      </View>}
      <Lines theme={theme} title={t("이전 답변", "Previous replies")} lines={item.replyHistory.map(entry => [entry.at, entry.text].filter(Boolean).join(" · "))} />
      {!isClosed && !needsRefresh && <View style={{ gap: 6 }}>
        {outstanding && <Text style={{ color: c.foregroundMuted }}>{t("각 질문에 답하거나 건너뛰기를 선택하세요.", "Answer or explicitly skip each question.")}</Text>}
        {confirming && <Text style={{ color: c.foreground }}>{t("이 보드에 확인 결과와 답을 기록하고 이 항목을 닫습니다. 세션에 보낼 답은 담당 세션에서 전달하세요.", "This saves your review and any answers on the board, then closes this record. Use the assigned session to send a reply.")}</Text>}
        <View style={wrap}>
          <Button theme={theme} {...named(confirming ? t("기록 닫기 확정", "Confirm closing record") : answer ? t("선택한 답 기록", "Record answers") : t("확인한 기록 닫기", "Close reviewed record"))}
            selected={confirming} disabled={busy || outstanding || tooLong} onPress={() => confirming ? void acknowledge() : setConfirming(true)} />
          {confirming && <Button theme={theme} {...named(t("취소", "Cancel"))} disabled={busy} onPress={() => setConfirming(false)} />}
        </View>
      </View>}
    </View>}
    {result && <Text accessibilityLiveRegion="polite" style={{ color: isClosed ? c.statusSuccess : c.statusWarning }}>{t(messages[result][0], messages[result][1])}</Text>}
    {needsRefresh && <View style={wrap}><Button theme={theme} {...named(t("결정 기록 새로 고침", "Refresh decision record"))}
      disabled={busy} onPress={() => void refreshRecord()} /></View>}
    {refreshFailed && <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>{t("최신 목록을 다시 불러오지 못했습니다. 보드를 새로 고쳐 주세요.", "Could not reload the list. Refresh the board.")}</Text>}
  </View>;
}
