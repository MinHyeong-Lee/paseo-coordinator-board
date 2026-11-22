import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { sendDecision, type DecisionInput } from "../shared/decision-actions";
import { requestRecommendation } from "../shared/recommendation";
import { decisionSummary } from "./decision-summary";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import type { Card } from "./model";

type Action = DecisionInput["action"];
type Editor = { action: Action; text: string; recipientId: string };
export type DecisionReceipt = { projectId: string; sessionId: string; version: string; source: string; project: string; recipient: string | null; action: Action };
const wrap = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };
const korean = { reply: "답장", question: "질문", coordinate: "조율 요청" };
const english = { reply: "reply", question: "question", coordinate: "coordination request" };

export function ReceiptText({ receipt, theme }: { receipt: DecisionReceipt; theme: Theme }) {
  const { t } = useBoardLanguage();
  const name = receipt.recipient || t("코디네이터 세션", "coordinator session");
  const kind = receipt.action;
  return <Text accessibilityLiveRegion="polite" selectable style={{ color: theme.colors.statusSuccess }}>
    {receipt.project} · {receipt.source} · {t(`${name}에 ${korean[kind]}을 보냈습니다.`, `Sent a ${english[kind]} to ${name}.`)}
  </Text>;
}

export function DecisionActions({ card, theme, coordinator, coordinatorTitle, open, onSent, receipt }: {
  card: Card; theme: Theme; coordinator: string | null; coordinatorTitle?: string; open?: (id: string) => void;
  onSent: (result: DecisionReceipt) => void; receipt?: DecisionReceipt;
}) {
  const { t, language } = useBoardLanguage();
  const { session } = card;
  const decision = session.decision;
  const c = theme.colors;
  const send = useRpc(sendDecision);
  const askRecommendation = useRpc(requestRecommendation);
  const [showMethods, setShowMethods] = useState(false);
  const [fullReply, setFullReply] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [requestedFrom, setRequestedFrom] = useState<string | null>(null);
  const recommendationKey = useRef({ recipient: "", key: "" });
  const [selection, setSelection] = useState<number | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<[string, string] | null>(null);
  const pending = useRef(false);
  const retry = useRef({ payload: "", key: "" });
  const delivered = useRef("");
  const chosen = selection === null ? null : decision?.options?.[selection];
  const proposed = chosen?.reply || (decision?.needsInput ? undefined : decision?.recommendation);
  const reviewReply = !!proposed && (proposed.length > 120 || proposed.includes("\n")) && !fullReply;
  const source = t(`담당 세션 · ${session.title}`, `Assigned session · ${session.title}`);
  const coordLabel = t(`코디네이터 · ${coordinatorTitle || coordinator}`, `Coordinator · ${coordinatorTitle || coordinator}`);
  const { headline, formal, evidence } = decisionSummary(card, t);
  const marker = [session.projectTitle, session.title, session.sourceProjectTitle && t(`원래 소속 ${session.sourceProjectTitle}`, `From ${session.sourceProjectTitle}`)].filter(Boolean).join(" · ");
  const named = (label: string) => ({ label, accessibilityLabel: `${session.title} · ${label}` });

  function begin(action: Action, text = "") {
    const recipientId = action === "coordinate" ? coordinator : session.id;
    if (!recipientId || !decision || formal || pending.current) return;
    setError(null); setEditor({ action, text, recipientId });
  }
  async function submit(action: Action, text: string, recipientId: string) {
    if (!decision || formal || !text.trim() || pending.current) return;
    if (recipientId !== (action === "coordinate" ? coordinator : session.id)) {
      setError(["받는 세션이 바뀌었습니다. 대상을 다시 선택해 주세요.", "The recipient changed. Choose the recipient again."]); return;
    }
    const input = { projectId: session.projectId, sessionId: session.id, version: decision.version, action, recipientId, text };
    const payload = JSON.stringify(input);
    if (delivered.current === payload) { setError(["이 카드에서 같은 내용을 이미 보냈습니다.", "You already sent this message from this card."]); return; }
    if (retry.current.payload !== payload) retry.current = { payload, key: "decision-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) };
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await send({ ...input, requestKey: retry.current.key });
      if (!result.ok || result.recipientId !== recipientId) {
        setError(["영수증의 수신자를 확인할 수 없습니다. 원래 세션을 확인해 주세요.", "The receipt does not confirm the recipient. Check the original session."]); return;
      }
      delivered.current = payload; setEditor(null);
      onSent({ projectId: session.projectId, sessionId: session.id, version: decision.version,
        project: session.projectTitle, source: session.title, recipient: action === "coordinate" ? coordinatorTitle || recipientId : session.title, action });
    } catch {
      setError(["전송을 확인하지 못했습니다. 최신 카드와 받는 세션을 확인한 뒤 다시 시도해 주세요.",
        "Delivery was not confirmed. Check the latest card and recipient before retrying."]);
    } finally { pending.current = false; setBusy(false); }
  }
  async function requestAdvice() {
    if (!decision || formal || !coordinator || decision.recommendation || decision.needsInput || pending.current || requestedFrom === coordinator) return;
    if (recommendationKey.current.recipient !== coordinator) {
      recommendationKey.current = { recipient: coordinator, key: "advice-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) };
    }
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await askRecommendation({ projectId: session.projectId, sessionId: session.id,
        version: decision.version, coordinator, language, requestKey: recommendationKey.current.key });
      if (!result.ok || result.recipientId !== coordinator) throw Error();
      setRequestedFrom(coordinator);
    } catch {
      setError(["추천 요청을 확인하지 못했습니다. 최신 카드와 코디네이터를 확인해 주세요.",
        "Could not confirm the recommendation request. Check the current card and coordinator."]);
    } finally { pending.current = false; setBusy(false); }
  }

  const targetChanged = editor?.action === "coordinate" && editor.recipientId !== coordinator;
  const openLabel = formal ? t("원래 세션에서 승인 확인", "Review approval in original session") : t("담당 세션 열기", "Open assigned session");
  const openButton = open && <Button theme={theme} {...named(openLabel)} selected={formal} onPress={() => open(session.id)} />;
  const sourceExcerpts = evidence.filter(text => text !== headline || headline.length > 36);
  const hasEvidence = !!decision?.recommendationReason || sourceExcerpts.length > 0;
  const adviceSent = !!coordinator && requestedFrom === coordinator;
  const disclose = (label: string, expanded: boolean, onPress: () => void) =>
    <Pressable accessibilityRole="button" accessibilityLabel={named(label).accessibilityLabel} accessibilityState={{ expanded }}
      style={{ paddingVertical: 6, paddingHorizontal: 3 }} onPress={onPress}>
      <Text style={{ color: c.foregroundMuted, fontSize: 13, textDecorationLine: "underline" }}>{label}</Text>
    </Pressable>;
  return <View style={{ gap: 7, paddingTop: 10, borderTopWidth: 1, borderColor: c.border }}>
    <Text accessibilityRole="header" selectable numberOfLines={hasEvidence ? 1 : undefined} style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>{headline}</Text>
    <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{marker}</Text>
    {formal || !decision ? <View style={wrap}>{openButton || <Text style={{ color: c.foregroundMuted }}>
      {formal ? t("원래 세션에서 승인 요청을 확인해 주세요.", "Review the approval request in the original session.") : t("원래 세션에서 요청을 확인해 주세요.", "Review the request in the original session.")}
    </Text>}</View> : <>
      {!editor && <>
        {!proposed && !!decision.needsInput && decision.needsInput !== headline && <Text selectable style={{ color: c.foreground }}>{decision.needsInput}</Text>}
        {!!proposed && <Text selectable numberOfLines={reviewReply ? 2 : undefined} style={{ color: c.foreground }}>{chosen ? t("선택한 답장", "Selected reply") : t("추천 답장", "Suggested reply")} · {proposed}</Text>}
        <View style={{ ...wrap, alignItems: "center" }}>
          {proposed ? <Button theme={theme} {...named(reviewReply ? t("답장 전문 확인", "Review full reply") : chosen ? t("선택한 답장 보내기", "Send selected reply") : t("추천 답장 보내기", "Send suggested reply"))}
            selected disabled={busy} onPress={() => reviewReply ? setFullReply(true) : void submit("reply", proposed, session.id)} />
            : decision.needsInput ? <Button theme={theme} {...named(t("필요한 정보 답하기", "Provide requested information"))} selected disabled={busy} onPress={() => begin("reply")} />
            : coordinator ? adviceSent
              ? <Text accessibilityLiveRegion="polite" style={{ color: c.statusSuccess }}>{t("추천 요청됨 · 코디네이터 답변 대기", "Recommendation requested · Awaiting coordinator")}</Text>
              : <Button theme={theme} {...named(t("코디네이터에 추천 요청", "Ask coordinator for a recommendation"))} selected disabled={busy} onPress={() => void requestAdvice()} />
            : openButton}
          {disclose(showMethods ? t("다른 방법 접기", "Hide alternatives") : t("다른 방법", "Other actions"), showMethods, () => setShowMethods(v => !v))}
        </View>
        {showMethods && <View style={{ gap: 7 }}>
          {!!decision.options?.length && <View style={wrap}>{decision.options.map((option, index) =>
            <Button key={index} theme={theme} label={option.label} selected={selection === index}
              accessibilityLabel={`${session.title} · ${t("선택", "Choose")} · ${option.label}`} disabled={busy}
              onPress={() => { setSelection(index); setShowMethods(false); setFullReply(false); setError(null); }} />)}</View>}
          <View style={wrap}>
            {chosen && decision.recommendation && <Button theme={theme} {...named(t("추천 답장으로 돌아가기", "Restore suggested reply"))} disabled={busy}
              onPress={() => { setSelection(null); setFullReply(false); setShowMethods(false); }} />}
            {!!proposed && <Button theme={theme} {...named(t("고쳐 보내기", "Edit reply"))} disabled={busy} onPress={() => begin("reply", proposed)} />}
            <Button theme={theme} {...named(t("직접 답장", "Write a reply"))} disabled={busy} onPress={() => begin("reply")} />
            <Button theme={theme} {...named(t("질문하기", "Ask a question"))} disabled={busy} onPress={() => begin("question")} />
            {!!coordinator && coordinator !== session.id && <Button theme={theme} {...named(t("코디네이터에 조율 요청", "Ask coordinator to coordinate"))} disabled={busy} onPress={() => begin("coordinate")} />}
            {(proposed || coordinator || decision.needsInput) && openButton}
          </View>
        </View>}
      </>}
      {editor && <View style={{ gap: 7 }}>
        <Text style={{ color: c.foregroundMuted }}>{t("받는 곳", "Recipient")} · {targetChanged ? editor.recipientId : editor.action === "coordinate" ? coordLabel : source}</Text>
        {targetChanged && <Text style={{ color: c.statusWarning }}>{t("코디네이터가 교체되었습니다. 취소하고 새 수신자를 확인해 주세요.", "The coordinator changed. Cancel and check the new recipient.")}</Text>}
        <TextInput accessibilityLabel={`${session.title} · ${t(korean[editor.action] + " 내용", english[editor.action] + " text")}`}
          placeholderTextColor={c.foregroundMuted} placeholder={t(`${korean[editor.action]} 내용을 입력하세요`, `Write your ${english[editor.action]}`)} value={editor.text} editable={!busy} multiline maxLength={24000}
          onChangeText={text => setEditor({ ...editor, text })}
          style={{ minHeight: 64, textAlignVertical: "top", padding: 8, color: c.foreground, borderRadius: 7, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0 }} />
        <View style={wrap}>
          <Button theme={theme} {...named(busy ? t("전송 중…", "Sending…") : editor.action === "coordinate" ? t("코디네이터에 조율 요청 보내기", "Send request to coordinator") : t(`담당 세션에 ${korean[editor.action]} 보내기`, `Send ${english[editor.action]} to assigned session`))}
            disabled={busy || targetChanged || !editor.text.trim()} onPress={() => void submit(editor.action, editor.text, editor.recipientId)} />
          <Button theme={theme} {...named(t("취소", "Cancel"))} disabled={busy} onPress={() => { setEditor(null); setError(null); }} />
        </View>
      </View>}
    </>}
    {hasEvidence && <View style={{ alignItems: "flex-start", gap: 4 }}>
      {disclose(showEvidence ? t("근거 접기", "Hide source") : t("근거 보기", "View source"), showEvidence, () => setShowEvidence(v => !v))}
      {showEvidence && decision?.recommendationReason && <Text selectable style={{ color: c.foreground }}>{t("추천 이유", "Reason for recommendation")} · {decision.recommendationReason}</Text>}
      {showEvidence && sourceExcerpts.map(text => <Text key={text} selectable style={{ color: c.foregroundMuted, fontSize: 13 }}>{text}</Text>)}
    </View>}
    {receipt && <ReceiptText receipt={receipt} theme={theme} />}
    {!!error && <Text accessibilityLiveRegion="polite" selectable style={{ color: c.statusDanger }}>{t(...error)}</Text>}
  </View>;
}
