import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  askDigest,
  operationState,
  requestWork,
  setupCoordinator,
  setProviderInclusion,
  updateRouting,
  type Operations,
} from "../shared/operations";
import { resolveRoute } from "../shared/dispatch";
import { Button, type Theme } from "./controls";
import { ProviderSettings } from "./providers";
import { RouteEditor, routeName, wrap } from "./route-editor";
import { explainEmptyRoute } from "./route-options";

type Props = {
  theme: Theme;
  settings: boolean;
  coordinator: string | null;
  configured: boolean;
  refreshBoard: () => void;
  openCoordinator?: (id: string) => void;
};

export function OperationsPanel({ theme, settings, coordinator, configured, refreshBoard, openCoordinator }: Props) {
  const fetchState = useRpc(operationState),
    setup = useRpc(setupCoordinator),
    includeProvider = useRpc(setProviderInclusion),
    savePolicy = useRpc(updateRouting);
  const sendWork = useRpc(requestWork),
    sendDigest = useRpc(askDigest);
  const [confirm, setConfirm] = useState(false);
  const [data, setData] = useState<Operations | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const [feedbackArea, setFeedbackArea] = useState<"provider" | "routing" | "coordinator">("provider");
  const pending = useRef(false),
    live = useRef(false),
    generation = useRef(0);
  const delivery = useRef({ payload: "", key: "" });
  const fetchRef = useRef(fetchState);
  fetchRef.current = fetchState;
  const refresh = useCallback(async (clearError = true) => {
    const token = ++generation.current;
    setLoading(true);
    try {
      const result = await fetchRef.current({});
      if (live.current && token === generation.current) {
        setData(result);
        if (clearError) setError("");
      }
    } catch (e) {
      if (live.current && token === generation.current) {
        setData(null);
        setFeedbackArea("provider");
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (live.current && token === generation.current) setLoading(false);
    }
  }, []);
  const needsModels = settings || (configured && !coordinator);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (needsModels) void refresh();
  }, [needsModels, settings, refresh]);
  useEffect(() => {
    setConfirm(false);
    delivery.current = { payload: "", key: "" };
  }, [coordinator]);
  useEffect(() => {
    setConfirm(false);
    setNotice("");
    setError("");
  }, [settings]);
  async function act<T>(fn: () => Promise<T>, done: string, area: typeof feedbackArea = "coordinator"): Promise<T | null> {
    if (pending.current) return null;
    pending.current = true;
    setBusy(true);
    setFeedbackArea(area);
    setError("");
    setNotice("");
    try {
      const value = await fn();
      if (live.current) {
        refreshBoard();
        setNotice(done);
      }
      return value;
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function post(kind: "digest" | "work") {
    if (!coordinator || pending.current) return;
    const message = text.trim();
    if (kind === "work" && !message) return;
    const payload = JSON.stringify([kind, coordinator, message]);
    if (delivery.current.payload !== payload)
      delivery.current = {
        payload,
        key: "board-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2),
      };
    const input = { coordinator, requestKey: delivery.current.key };
    const receipt = await act(
      () => (kind === "digest" ? sendDigest(input) : sendWork({ ...input, text: message })),
      kind === "digest"
        ? "다이제스트를 요청했습니다. 코디네이터 세션에서 답을 확인하세요."
        : "코디네이터에게 맡겼습니다. 세션에서 배정과 진행을 확인하세요.",
    );
    if (receipt && live.current) {
      delivery.current = { payload: "", key: "" };
      if (kind === "work") setText("");
    }
  }
  if (!settings && !configured && !coordinator) return null;
  const model = data && resolveRoute("M", data.routing, data.catalog);
  const mode = data?.coordinatorMode;
  const modeText = mode ? `도구 권한 · ${mode.label}` : "권한 모드를 확인할 수 없습니다. 설정에서 실행기·모델을 새로 고쳐 주세요.";
  const color = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const section = { gap: 10, backgroundColor: theme.colors.surface1, padding: 14, borderRadius: 10 };
  const heading = { color, fontWeight: "600" as const, fontSize: 17 };
  const feedback = <>
    {!!error && <Text accessibilityLiveRegion="polite" selectable style={{ color: theme.colors.statusDanger }}>{error}</Text>}
    {!!notice && <Text accessibilityLiveRegion="polite" style={{ color }}>{notice}</Text>}
  </>;

  function connect() {
    if (!model || !mode || !configured) return;
    void act(
      () => setup({ expectedCoordinator: coordinator, replace: !!coordinator, expectedRoute: model, expectedModeId: mode.id }),
      "운영 세션을 연결했습니다.",
    ).then((result) => {
      if (result && live.current) setConfirm(false);
    });
  }

  if (settings) return <View style={{ gap: 14 }}>
    <View style={section}>
      <View style={{ ...wrap, alignItems: "center", justifyContent: "space-between" }}>
        <Text accessibilityRole="header" style={heading}>Paseo 실행기</Text>
        <Button theme={theme} label={loading ? "실행기 조회 중…" : "실행기·모델 새로 고침"} disabled={loading || busy} onPress={() => void refresh()} />
      </View>
      <Text style={{ color: muted }}>새로 발견한 실행기는 기본으로 포함됩니다. 연결된 모델이 있는 실행기에 작업을 배정합니다.</Text>
      {data && <ProviderSettings theme={theme} providers={data.providers} busy={busy || loading} change={async (provider, included) => {
        const result = await act(() => includeProvider({ provider, included, expectedRevision: data.revision }),
          included ? "이 실행기를 새 작업 배정에 포함했습니다." : "이 실행기를 새 작업 배정에서 제외했습니다.", "provider");
        if (live.current) await refresh(!!result);
      }} />}
      {feedbackArea === "provider" && feedback}
    </View>
    <View style={section}>
      <Text accessibilityRole="header" style={heading}>모델 배정</Text>
      <Text style={{ color: muted }}>추천 설정은 연결된 실행기에서 사용할 수 있는 모델을 고릅니다. 직접 정하려면 후보를 원하는 순서대로 저장하세요.</Text>
      {data && <RouteEditor
        data={data}
        theme={theme}
        busy={busy || loading}
        save={async (grade, candidates, expectedRevision) => {
          const result = await act(
            () => savePolicy({ grade, candidates, expectedRevision }),
            grade === "M" ? "운영 세션 모델을 저장했습니다. 다음 생성 또는 교체부터 적용됩니다." : "배정표를 저장했습니다. 다음 배정부터 적용됩니다.",
            "routing",
          );
          if (live.current) await refresh(!!result);
          return !!result;
        }}
      />}
      {feedbackArea === "routing" && feedback}
    </View>
    {configured && coordinator && <View style={section}>
      <Text accessibilityRole="header" style={heading}>운영 세션 교체</Text>
      <Text style={{ color: muted }}>새 코디네이터를 만들 때 쓸 모델 · {loading ? "조회 중…" : routeName(model)}</Text>
      {!loading && model && <Text style={{ color: muted }}>{modeText}</Text>}
      {!loading && data && !model && <Text style={{ color: muted }}>{explainEmptyRoute(data, "M")}</Text>}
      {confirm && <Text style={{ color }}>새 운영 세션이 준비되면 담당자를 바꿉니다. 진행 중인 작업과 결정 카드는 유지됩니다.</Text>}
      <View style={wrap}>
        <Button theme={theme} label={confirm ? "교체 취소" : "새 코디네이터로 교체…"}
          disabled={busy || (!confirm && (loading || !model || !mode))} onPress={() => setConfirm(!confirm)} />
        {confirm && <Button theme={theme} label="새 세션으로 교체" disabled={busy || loading || !model || !mode} onPress={connect} />}
      </View>
      {feedbackArea === "coordinator" && feedback}
    </View>}
  </View>;

  return <View style={section}>
    <Text accessibilityRole="header" style={heading}>코디네이터</Text>
    {coordinator ? <>
      <TextInput accessibilityLabel="코디네이터에게 맡길 일" placeholder="어떤 일을 맡길까요?" value={text}
        editable={!busy} multiline maxLength={24000} onChangeText={setText} />
      <View style={wrap}>
        <Button theme={theme} label="코디네이터에 작업 맡기기" disabled={busy || !configured || !text.trim()} onPress={() => void post("work")} />
        <Button theme={theme} label="다이제스트 요청" disabled={busy || !configured} onPress={() => void post("digest")} />
        {openCoordinator && <Button theme={theme} label="코디네이터 세션 열기" onPress={() => openCoordinator(coordinator)} />}
      </View>
      <Text style={{ color: muted }}>요청을 보내면 코디네이터 모델이 실행됩니다. 선택한 프로젝트 안에서 담당 세션과 모델을 고릅니다.</Text>
    </> : <>
      <Text style={{ color: muted }}>{loading ? "사용할 수 있는 모델을 확인하고 있습니다." :
        model ? `연결된 모델로 운영 세션을 만듭니다 · ${routeName(model)}` :
        data ? explainEmptyRoute(data, "M") : "설정에서 실행기와 모델을 새로 고쳐 주세요."}</Text>
      {!loading && model && <Text style={{ color: muted }}>{modeText}</Text>}
      <View style={wrap}><Button theme={theme} label={data?.routing.M ? "저장한 모델로 시작" : "추천 설정으로 시작"} disabled={busy || loading || !model || !mode} onPress={connect} /></View>
    </>}
    {feedback}
  </View>;
}
