import { useState } from "react";
import { Text, View } from "react-native";
import { eligibleProvider, workerGradeSchema } from "../shared/dispatch";
import type { Operations } from "../shared/operations";
import { Button, type Theme } from "./controls";

type Provider = Operations["providers"][number];

function catalogStatus(provider: Provider) {
  if (provider.status === "unavailable") return "사용 불가";
  if (provider.status === "error") return "모델 조회 실패";
  if (provider.status === "empty") return "모델 없음";
  return provider.modelCount === null ? "모델 수 미확인" : `모델 ${provider.modelCount}개`;
}

function roles(id: string) {
  const grades = workerGradeSchema.options.filter(grade => eligibleProvider(grade, id));
  const worker = grades.length === 4 ? "A~D" : grades.join("·");
  const scope = [`작업 ${worker}`];
  if (eligibleProvider("M", id)) scope.push("운영 M");
  if (eligibleProvider("D", id, true)) scope.push("필수 훅");
  return scope.join(" / ");
}

export function ProviderSettings({ providers, theme, busy, change }: {
  providers: Provider[];
  theme: Theme;
  busy: boolean;
  change: (provider: string, included: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [width, setWidth] = useState(0);
  const columns = Math.max(1, Math.floor((width + 8) / 260));
  const cardWidth = width > 0 ? Math.floor((width - 8 * (columns - 1)) / columns) : "100%";
  const c = theme.colors;
  if (!providers.length) return <Text style={{ color: c.foregroundMuted }}>Paseo가 발견한 실행기가 없습니다. Paseo에서 실행기를 연결한 뒤 새로 고쳐 주세요.</Text>;
  const included = providers.filter(p => p.included);
  const ready = included.filter(p => p.available && p.status === "ready");
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ color: c.foregroundMuted }}>발견 {providers.length}개 · 배정에 포함 {included.length}개 · 모델 선택 가능 {ready.length}개</Text>
      <Button theme={theme} label={expanded ? "목록 접기" : "실행기 목록 펼치기"} onPress={() => setExpanded(!expanded)} />
    </View>
    {expanded && <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {providers.map(provider => <View key={provider.id} style={{
        width: cardWidth, padding: 10, gap: 5,
        borderWidth: 1, borderRadius: 8, borderColor: c.border, backgroundColor: c.surface0,
      }}>
        <Text selectable style={{ fontWeight: "600", color: c.foreground }}>{provider.label}</Text>
        <Text selectable style={{ fontSize: 12, color: c.foregroundMuted }}>{provider.id} · {catalogStatus(provider)}</Text>
        <Text style={{ fontSize: 12, color: c.foregroundMuted }}>{roles(provider.id)}</Text>
        <View style={{ flexDirection: "row" }}>
          <Button theme={theme} selected={provider.included} disabled={busy}
            label={provider.included ? "배정에 포함됨" : "배정에서 제외됨"}
            accessibilityLabel={`${provider.id} · 배정${provider.included ? "에서 제외" : "에 포함"}`}
            onPress={() => change(provider.id, !provider.included)} />
        </View>
      </View>)}
    </View>}
  </View>;
}
