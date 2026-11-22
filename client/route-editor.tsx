import { Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import {
  workerGradeSchema,
  resolveRoute,
  sameRoute,
  type Grade,
  type RouteChoice,
} from "../shared/dispatch";
import type { Operations } from "../shared/operations";
import { Button, type Theme } from "./controls";
import { browseModels, explainEmptyRoute, savedCandidateIssue } from "./route-options";

export const gradeLabels = { A: "A · 최상", B: "B · 높음", C: "C · 중간", D: "D · 기본", M: "M · 코디네이터" };
export function routeName(route: RouteChoice | null) {
  return route ? [route.provider, route.model, route.effort].filter(Boolean).join(" / ") : "사용 가능한 후보 없음";
}
export const wrap = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };

type Props = {
  data: Operations;
  theme: Theme;
  busy: boolean;
  save: (grade: Grade, rows: RouteChoice[], revision: number) => Promise<boolean>;
};
export function RouteEditor({ data, theme, busy, save }: Props) {
  const [grade, setGrade] = useState<Grade>("C");
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>작업 난이도</Text>
      <View style={wrap}>
        {workerGradeSchema.options.map((g) => (
          <Button
            key={g}
            theme={theme}
            label={gradeLabels[g]}
            selected={g === grade}
            onPress={() => setGrade(g)}
          />
        ))}
      </View>
      <View style={{ ...wrap, alignItems: "center" }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>운영 세션</Text>
        <Button theme={theme} label={gradeLabels.M} selected={grade === "M"} onPress={() => setGrade("M")} />
      </View>
      {grade === "M" && <Text style={{ color: theme.colors.foregroundMuted }}>M은 코디네이터를 만들거나 교체할 때 사용합니다. 현재 세션은 그대로 운영됩니다.</Text>}
      <CandidateList key={grade + ":" + data.revision} {...{ data, theme, busy, grade, save }} />
    </View>
  );
}
function CandidateList({ data, theme, busy, grade, save }: Props & { grade: Grade }) {
  const [rows, setRows] = useState<RouteChoice[]>(data.routing[grade] ?? []);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(6);
  const [provider, setProvider] = useState<string | null>(null);
  const [selection, setSelection] = useState<RouteChoice | null>(null);
  const color = theme.colors.foreground;
  const browser = browseModels(data, grade, provider, query, limit);
  const model = selection && browser.choices.find(m => m.model === selection.model && m.provider === selection.provider);
  const saved = data.routing[grade]?.length;
  const route = resolveRoute(grade, data.routing, data.catalog);
  function filter(id: string | null) {
    setProvider(id);
    setSelection(null);
    setLimit(6);
  }
  return (
    <View style={{ gap: 7 }}>
      <Text style={{ color }}>{saved ? "저장된 배정" : "추천 설정"} · {routeName(route)}</Text>
      {!route && <Text style={{ color: theme.colors.foregroundMuted }}>{explainEmptyRoute(data, grade)}</Text>}
      {rows.map((r, i) => {
        const issue = savedCandidateIssue(data, grade, r);
        return (
          <View key={JSON.stringify(r)} style={wrap}>
            <Text style={{ color }}>
              {i === 0 ? "우선" : `예비 ${i}`} · {routeName(r)}{issue ? " · " + issue : ""}
            </Text>
            {i > 0 && (
              <Button
                theme={theme}
                label="앞으로"
                disabled={busy}
                onPress={() => {
                  const next = [...rows];
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  setRows(next);
                }}
              />
            )}
            <Button
              theme={theme}
              label="후보 제외"
              disabled={busy}
              onPress={() => setRows(rows.filter((_, index) => i !== index))}
            />
          </View>
        );
      })}
      {browser.providers.length > 1 && <View style={wrap}>
        <Button theme={theme} label="전체 실행기" selected={browser.active === null} onPress={() => filter(null)} />
        {browser.providers.map(p => <Button key={p.id} theme={theme}
          label={`${p.label} · ${p.count}`}
          selected={browser.active === p.id} onPress={() => filter(p.id)} />)}
      </View>}
      <TextInput
        accessibilityLabel="모델 검색"
        placeholder="실행기 또는 모델 검색"
        value={query}
        onChangeText={(v) => {
          setQuery(v);
          setLimit(6);
          setSelection(null);
        }}
      />
      {browser.hint && <Text style={{ color: theme.colors.foregroundMuted }}>{browser.hint}</Text>}
      <View style={wrap}>
        {browser.choices.map((m) => (
          <Button
            key={JSON.stringify([m.provider, m.model])}
            theme={theme}
            label={m.provider + " / " + m.model}
            selected={selection?.provider === m.provider && selection.model === m.model}
            onPress={() => setSelection({ provider: m.provider, model: m.model, effort: null })}
          />
        ))}
        {browser.choices.length < browser.count && (
          <Button theme={theme} label="모델 더 보기" onPress={() => setLimit(limit + 12)} />
        )}
      </View>
      {model && selection && (
        <View style={{ gap: 6 }}>
          <Text style={{ color }}>추론 강도</Text>
          <View style={wrap}>
            {[null, ...model.efforts].map((e) => (
              <Button
                theme={theme}
                key={e ?? "default"}
                label={e ?? "실행기 기본 강도"}
                selected={e === selection.effort}
                onPress={() => setSelection({ ...selection, effort: e })}
              />
            ))}
            <Button
              theme={theme}
              label="후보에 추가"
              disabled={busy || rows.length >= 12 || rows.some((r) => sameRoute(r, selection))}
              onPress={() => {
                setRows([...rows, selection]);
                setSelection(null);
              }}
            />
          </View>
        </View>
      )}
      <View style={wrap}>
        <Button
          theme={theme}
          label="배정표 저장"
          disabled={busy || JSON.stringify(rows) === JSON.stringify(data.routing[grade] ?? [])}
          onPress={() => void save(grade, rows, data.revision)}
        />
        <Button
          theme={theme}
          label="추천으로 복원"
          disabled={busy || !data.routing[grade]}
          onPress={() => void save(grade, [], data.revision)}
        />
      </View>
    </View>
  );
}
