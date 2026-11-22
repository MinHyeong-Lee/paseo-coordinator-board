import { eligibleProvider, type CatalogModel, type Grade, type ProviderEntry, type RouteChoice } from "../shared/dispatch";
import type { Operations } from "../shared/operations";

type ModelDirectory = Pick<Operations, "providers" | "catalog" | "routing">;

export function savedCandidateIssue(data: ModelDirectory, grade: Grade, row: RouteChoice) {
  const p = data.providers.find(p => p.id === row.provider);
  if (!p) return "Paseo 목록에 없는 실행기";
  if (!p.included) return "배정에서 제외한 실행기";
  if (!eligibleProvider(grade, p.id)) return "이 등급에서 허용하지 않는 실행기";
  if (!p.available || p.status === "unavailable") return "연결을 확인할 실행기";
  if (p.status === "error") return "모델 조회 실패";
  if (p.status === "empty") return "선택할 모델 없음";
  const model = data.catalog.find(m => m.provider === row.provider && m.model === row.model);
  if (!model) return "현재 목록에 없는 모델";
  if (row.effort !== null && !model.efforts.includes(row.effort)) return "현재 지원하지 않는 추론 강도";
  return null;
}

export function explainEmptyRoute(data: ModelDirectory, grade: Grade) {
  const saved = data.routing[grade];
  if (saved?.length) {
    const problems = [...new Set(saved.map(row => savedCandidateIssue(data, grade, row)).filter(Boolean))];
    return `저장된 후보를 사용할 수 없습니다 (${problems.join(", ")}). 실행기 설정을 확인하거나, 다른 후보를 추가해 저장하거나 ‘추천으로 복원’을 선택하세요.`;
  }
  if (!data.providers.length) return "Paseo에서 실행기를 연결한 뒤 목록을 새로 고쳐 주세요.";
  const eligible = data.providers.filter(p => eligibleProvider(grade, p.id));
  if (!eligible.length) {
    if (grade === "A" || grade === "B" || grade === "M") {
      return `${grade} 등급을 맡을 Claude Code 또는 Codex를 Paseo에서 연결한 뒤 목록을 새로 고쳐 주세요.`;
    }
    return "연결된 실행기의 허용 등급을 확인하고, 이 작업을 맡을 실행기를 Paseo에 연결하세요.";
  }
  const included = eligible.filter(p => p.included);
  const disabled = eligible.filter(p => !p.included);
  const notes: string[] = [];
  const names = (list: ProviderEntry[]) => list.map(p => p.label).join(", ");
  const groups = [
    { list: included.filter(p => !p.available || p.status === "unavailable"), action: "Paseo에서 실행기 연결을 확인하세요." },
    { list: included.filter(p => p.available && p.status === "error"), action: "모델 조회에 실패했습니다. 목록을 새로 고쳐 주세요." },
    { list: included.filter(p => p.available && p.status === "empty"), action: "선택할 모델이 없습니다. Paseo에서 모델 설정을 확인하세요." },
    { list: disabled, action: "배정에서 제외되어 있습니다. ‘Paseo 실행기’에서 사용할 실행기를 다시 포함하세요." },
  ];
  for (const { list, action } of groups) {
    if (list.length) notes.push(`${names(list)} · ${action}`);
  }
  return notes.join("\n") || "이 등급에 사용할 수 있는 모델이 없습니다. 실행기와 모델 목록을 새로 고쳐 주세요.";
}

// Preserve each provider's catalog order and give every provider a first result before its second.
export function browseModels(data: ModelDirectory, grade: Grade, providerId: string | null, query: string, limit: number) {
  const byProvider = new Map(data.providers
    .filter(p => p.included && p.available && p.status === "ready" && eligibleProvider(grade, p.id))
    .map(p => [p.id, { id: p.id, label: p.label, models: [] as CatalogModel[] }]));
  for (const model of data.catalog) byProvider.get(model.provider)?.models.push(model);
  const groups = [...byProvider.values()].filter(p => p.models.length > 0);
  const providers = groups.map(p => ({
    id: p.id,
    label: groups.some(other => other.id !== p.id && other.label === p.label) ? `${p.label} (${p.id})` : p.label,
    count: p.models.length,
  }));
  const active = providers.some(p => p.id === providerId) ? providerId : null;
  const search = query.trim().toLowerCase();
  const matches = groups.map(p => ({
    id: p.id,
    models: p.models.filter(m => [m.provider, p.label, m.model, m.label].join(" ").toLowerCase().includes(search)),
  }));
  const visible = matches.filter(p => !active || active === p.id);
  const count = visible.reduce((sum, p) => sum + p.models.length, 0);
  const choices: CatalogModel[] = [];
  const wanted = Math.min(count, limit);
  for (let i = 0; choices.length < wanted; i++) {
    for (const p of visible) {
      if (p.models[i]) choices.push(p.models[i]);
      if (choices.length === wanted) break;
    }
  }
  let hint: string | null = null;
  if (search && providers.length && !count) {
    hint = active && matches.some(p => p.id !== active && p.models.length)
      ? "다른 실행기에 검색 결과가 있습니다. ‘전체 실행기’를 선택하세요."
      : "검색 결과가 없습니다. 모델 ID로 검색하거나 검색어를 지워 주세요.";
  }
  return { providers, active, count, choices, hint };
}
