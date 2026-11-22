import { Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { Button, type Theme } from "./controls";
import { noteLabels, type Note, type NoteInput, type Session } from "./model";

type Props = {
  session: Session; note?: Note; theme: Theme; onClose: () => void;
  onSetReporting: (enabled: boolean) => Promise<boolean>;
  onSave: (input: NoteInput) => Promise<{ ok: boolean; conflict: boolean }>;
};

export function NoteEditor({ session, note, theme, onClose, onSave, onSetReporting }: Props) {
  const c = theme.colors;
  const [kind, setKind] = useState<keyof typeof noteLabels>(note && note.kind !== "clear" ? note.kind : "question");
  const [text, setText] = useState(note?.text ?? "");
  const [evidenceId] = useState(session.evidenceId);
  const [revision, setRevision] = useState(note?.revision ?? 0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const submitting = useRef(false);
  async function toggleReporting() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      const ok = await onSetReporting(!session.reporting);
      if (!ok) setMessage("보고 설정을 저장하지 못했습니다.");
    } catch {
      setMessage("호스트에 연결할 수 없어 보고 설정을 저장하지 못했습니다.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const conflict = revision !== (note?.revision ?? 0);
  async function submit(as: NoteInput["kind"]) {
    if (submitting.current || conflict || (as !== "clear" && !text.trim())) return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await onSave({ sessionId: session.id, expectedRevision: revision, evidenceId, kind: as, text: as === "clear" ? "" : text.trim() });
      if (result.ok) onClose();
      else setMessage(result.conflict ? "다른 곳에서 기록을 수정했습니다. 최신 기록을 확인해 주세요." : "기록을 저장하지 못했습니다. 다시 시도해 주세요.");
    } catch {
      setMessage("호스트에 저장하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title="세션 기록" open onOpenChange={(open) => { if (!open && !submitting.current) onClose(); }}>
      <Modal.Content>
        <Text style={{ fontSize: 17, fontWeight: "600", color: c.foreground }}>{session.title}</Text>
        <Text style={{ fontSize: 13, color: c.foregroundMuted }}>{session.projectTitle} · {session.workspaceTitle}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {(["question", "review", "done"] as const).map((type) => (
            <Button key={type} label={noteLabels[type]} theme={theme} selected={kind === type} disabled={busy} onPress={() => setKind(type)} />
          ))}
        </View>
        {note?.origin === "agent" && note.kind !== "clear" &&
          <Text style={{ color: c.foregroundMuted }}>세션이 남긴 보고입니다. 원문에서 결과를 확인하고 기록을 저장하세요.</Text>}
        <TextInput accessibilityLabel={noteLabels[kind]} multiline maxLength={2000} editable={!busy} value={text} onChangeText={setText}
          placeholder={{ question: "어떤 결정을 내려야 하나요?", review: "무엇을 확인하면 될까요?", done: "완료를 확인한 결과나 링크를 적어 주세요." }[kind]}
          placeholderTextColor={c.foregroundMuted}
          style={{ minHeight: 100, textAlignVertical: "top", padding: 12, color: c.foreground, borderRadius: 7, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0 }} />
        {conflict && <View style={{ gap: 7 }}>
          <Text style={{ color: c.statusWarning }}>편집 중에 기록이 바뀌었습니다. 내 초안은 여기에 남아 있습니다.</Text>
          <Text style={{ color: c.foreground }}>{note && note.kind !== "clear" ? `최신 기록 · ${noteLabels[note.kind]} · ${note.text}` : "최신 기록이 해제되었습니다."}</Text>
          <Button theme={theme} label="최신 기록 확인 · 내 초안 계속 편집" onPress={() => { setRevision(note?.revision ?? 0); setMessage(""); }} />
        </View>}
        {!!message && <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>{message}</Text>}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button theme={theme} label={busy ? "저장 중…" : "저장"} selected disabled={busy || conflict || !text.trim()} onPress={() => void submit(kind)} />
          {note && note.kind !== "clear" &&
            <Button theme={theme} label="기록 해제" disabled={busy || conflict} onPress={() => void submit("clear")} />}
          <Button theme={theme} label="취소" disabled={busy} onPress={onClose} />
        </View>
        <View style={{ gap: 7, borderTopWidth: 1, borderColor: c.border, paddingTop: 10 }}>
          <Text style={{ color: c.foreground, fontWeight: "600" }}>이 세션의 보드 보고 받기 · {session.reporting ? "켬" : "끔"}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Paseo 도구 연결(MCP)을 허용한 호스트에서 쓸 수 있습니다. 켠 세션은 다음에 대화용으로 열릴 때부터 질문과 확인할 결과를 자기 카드에 올릴 수 있습니다.</Text>
          <Button theme={theme} label={session.reporting ? "보드 보고 끄기" : "보드 보고 켜기"} disabled={busy} onPress={() => void toggleReporting()} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
