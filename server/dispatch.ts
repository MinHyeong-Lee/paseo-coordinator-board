import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { reportingKey } from "../shared/contract";
import {
  dispatchInputSchema, includedCatalog, resolveRoute, sameRoute,
  type CatalogModel, type DispatchInput, type ProviderEntry, type RouteChoice, type RoutePolicy, type WorkspaceChoice,
} from "../shared/dispatch";
import { readPages } from "./discovery";

export { resolveRoute, validateCandidates } from "../shared/dispatch";

type Sdk = PluginHandlerContext["paseo"];
type PaseoWorkspace = Awaited<ReturnType<Sdk["workspaces"]["list"]>>["entries"][number];
type PaseoAgentConfig = Parameters<Sdk["agents"]["create"]>[0]["config"];
type DispatchScope = { projects: string[]; routing: RoutePolicy; coordinator: string | null; excludedProviders: string[] };
type Directory = { providers: Omit<ProviderEntry, "included">[]; catalog: CatalogModel[] };

export async function readProviderAvailability(paseo: Pick<Sdk, "providers">) {
  try {
    const result = await paseo.providers.listAvailable();
    if (!result.error) return result.providers;
  } catch {
    // RPC diagnostics may contain local paths or configuration details.
  }
  throw new Error("호스트의 실행기 목록을 확인하지 못했습니다.");
}

export async function readProviderDirectory(paseo: Pick<Sdk, "providers">, cwd?: string, withLabels = false): Promise<Directory> {
  const [availability, labels] = await Promise.all([
    readProviderAvailability(paseo),
    withLabels ? paseo.providers.snapshot().then(s => new Map(s.entries.map(e => [e.provider, e.label]))).catch(() => null) : null,
  ]);
  const rows = await Promise.all(availability.map(async ({ provider, available, error }) => {
    const info: Omit<ProviderEntry, "included"> = {
      id: provider, label: labels?.get(provider)?.trim() || provider, available,
      status: available ? "error" : "unavailable", modelCount: null,
    };
    const models: CatalogModel[] = [];
    if (available && !error) {
      try {
        const result = await paseo.providers.listModels(provider, cwd ? { cwd } : undefined);
        if (!result.error && Array.isArray(result.models)) {
          for (const model of result.models) {
            if (model.isSelectable === false) continue;
            models.push({
              provider, model: model.id, label: model.label, isDefault: !!model.isDefault,
              // Cursor exposes effort variants as selectable model IDs.
              efforts: provider === "cursor" ? [] : (model.thinkingOptions ?? []).map(option => option.id),
            });
          }
          info.modelCount = models.length;
          info.status = models.length ? "ready" : "empty";
        }
      } catch {
        // Keep this provider visible with unknown count; other providers still work.
      }
    }
    return { info, models };
  }));
  return { providers: rows.map(row => row.info), catalog: rows.flatMap(row => row.models) };
}

export async function readCatalog(paseo: Pick<Sdk, "providers">, cwd?: string) {
  const directory = await readProviderDirectory(paseo, cwd);
  const available = directory.providers.filter(p => p.available);
  if (available.length && available.every(p => p.status === "error"))
    throw new Error("이 호스트의 모델 목록을 읽지 못했습니다. 연결을 확인하고 다시 시도해 주세요.");
  return directory.catalog;
}

export function configForRoute(choice: RouteChoice): PaseoAgentConfig {
  return {
    provider: choice.provider + "/" + choice.model,
    ...(choice.effort !== null ? { thinkingOptionId: choice.effort } : {}),
  };
}

function usable(workspace: PaseoWorkspace) {
  return !workspace.internal && !workspace.background && !workspace.archivingAt && !!workspace.workspaceDirectory &&
    (!workspace.setupStatus || workspace.setupStatus === "completed");
}

export async function readManagedWorkspaces(paseo: Pick<Sdk, "workspaces">, projects: string[]): Promise<WorkspaceChoice[]> {
  if (!projects.length) return [];
  const rows = await readPages<PaseoWorkspace>(page => paseo.workspaces.list({
    filter: { includeBackground: false }, sort: [{ key: "project_id", direction: "asc" }], page,
  }));
  return rows.filter(w => usable(w) && projects.includes(w.projectId)).map(w => ({
    id: w.id, projectId: w.projectId, title: w.title?.trim() || w.name,
  }));
}

// A caller-chosen UUID keeps old hosts from silently falling back to unkeyed create-and-prompt.
function creationUuid(key: string, kind: "agent" | "prompt") {
  const bytes = createHash("sha256").update("coordinator-board/dispatch/" + kind + "/" + key).digest();
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

const fingerprintKey = "coordinator-board/dispatch-intent";
const parentKey = "coordinator-board/dispatch-parent";

export async function dispatchWorker(paseo: Pick<Sdk, "agents" | "workspaces" | "providers">, request: DispatchInput, getScope: () => DispatchScope) {
  const input = dispatchInputSchema.parse(request);
  const scopeForProject = () => {
    const state = getScope();
    if (typeof state.coordinator !== "string" || !state.coordinator) throw new Error("현재 기기의 코디네이터를 먼저 지정해 주세요.");
    if (!state.projects.includes(input.projectId)) throw new Error("이 호스트에서 관리할 프로젝트를 먼저 선택해 주세요.");
    return { coordinator: state.coordinator, routing: state.routing, excluded: state.excludedProviders };
  };
  scopeForProject();
  const sessionId = creationUuid(input.requestKey, "agent");
  const fingerprint = createHash("sha256").update(JSON.stringify([
    input.projectId, input.workspaceId, input.grade, input.title, input.prompt, !!input.needsHooks,
    input.expectedRoute.provider, input.expectedRoute.model, input.expectedRoute.effort,
  ])).digest("hex");
  const workspace = paseo.workspaces.ref(input.workspaceId);
  const [target, receipt] = await Promise.all([workspace.refresh(), paseo.agents.ref(sessionId).refresh()]);
  if (!target || target.id !== input.workspaceId || target.projectId !== input.projectId || !usable(target)) {
    throw new Error("선택한 프로젝트에서 작업 가능한 워크스페이스를 다시 골라 주세요.");
  }
  let parent: string;
  const route = input.expectedRoute;
  if (receipt) {
    scopeForProject();
    if (receipt.agent.id !== sessionId || receipt.agent.workspaceId !== target.id || receipt.agent.metadata?.[fingerprintKey] !== fingerprint) {
      throw new Error("이미 다른 작업에 사용한 요청입니다. 새 작업으로 시작해 주세요.");
    }
    const previousParent = receipt.agent.metadata[parentKey];
    if (typeof previousParent !== "string" || !previousParent) throw new Error("기존 작업의 상위 세션을 확인할 수 없습니다.");
    parent = previousParent;
    // An agent snapshot alone does not confirm that its initial prompt was accepted.
    // Replay the original creation key/payload so the daemon settles that operation.
  } else {
    const catalog = await readCatalog(paseo, target.workspaceDirectory);
    const state = scopeForProject();
    const selected = resolveRoute(input.grade, state.routing, includedCatalog(catalog, state.excluded), input.needsHooks);
    if (!selected || !sameRoute(route, selected)) {
      throw new Error("현재 배정 결과가 미리보기와 다릅니다. 호스트와 모델을 다시 확인해 주세요.");
    }
    parent = state.coordinator;
  }
  const worker = await workspace.agents.create({
    agentId: sessionId, idempotencyKey: "coordinator-board/worker/" + input.requestKey,
    clientMessageId: creationUuid(input.requestKey, "prompt"),
    parent,
    config: configForRoute(route), title: input.title, prompt: input.prompt,
    metadata: {
      [reportingKey]: true, [fingerprintKey]: fingerprint, "coordinator-board/grade": input.grade,
      [parentKey]: parent,
    },
  });
  if (worker.id !== sessionId || worker.workspaceId !== target.id) throw new Error("생성된 세션과 대상 워크스페이스가 일치하는지 확인해 주세요.");
  return { sessionId, route };
}
