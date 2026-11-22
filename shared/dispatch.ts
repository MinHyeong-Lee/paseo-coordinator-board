import { z } from "zod";

const identifier = z.string().min(1).max(256);
const projectId = z.string().min(1).max(4096);
export const gradeSchema = z.enum(["A", "B", "C", "D", "M"]);
export const workerGradeSchema = z.enum(["A", "B", "C", "D"]);
export const routeChoiceSchema = z.object({
  provider: identifier,
  model: identifier,
  effort: identifier.nullable(),
});
export const providerEntrySchema = z.object({
  id: identifier, label: z.string(), available: z.boolean(), included: z.boolean(),
  status: z.enum(["ready", "empty", "unavailable", "error"]), modelCount: z.number().int().nonnegative().nullable(),
});
export type ProviderEntry = z.infer<typeof providerEntrySchema>;

export const catalogModelSchema = z.object({
  provider: identifier, model: identifier, label: z.string(),
  efforts: z.array(identifier), isDefault: z.boolean(),
  coordinatorMode: z.object({ id: identifier, label: z.string() }).nullable().optional(),
});
export const routePolicySchema = z.partialRecord(gradeSchema, z.array(routeChoiceSchema).min(1).max(12));
export const workspaceChoiceSchema = z.object({ id: identifier, projectId, title: z.string() });
export const dispatchInputSchema = z.strictObject({
  projectId, workspaceId: identifier, grade: workerGradeSchema,
  title: z.string().trim().min(1).max(160), prompt: z.string().trim().min(1).max(24000),
  requestKey: z.string().min(12).max(96).regex(/^[a-zA-Z0-9_-]+$/),
  expectedRoute: routeChoiceSchema, needsHooks: z.boolean().optional(),
});

export type Grade = z.infer<typeof gradeSchema>;
export type WorkerGrade = z.infer<typeof workerGradeSchema>;
export type RouteChoice = z.infer<typeof routeChoiceSchema>;
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type RoutePolicy = z.infer<typeof routePolicySchema>;
export type WorkspaceChoice = z.infer<typeof workspaceChoiceSchema>;
export type DispatchInput = z.infer<typeof dispatchInputSchema>;

function primary(provider: string) {
  return provider === "claude" || provider === "codex";
}

export function eligibleProvider(grade: Grade, provider: string, needsHooks = false, catalog?: readonly CatalogModel[]) {
  if (needsHooks && !primary(provider)) return false;
  if (grade === "M") {
    if (!catalog) return primary(provider);
    // Old catalogs omitted mode discovery for Claude Code and Codex.
    const hasMode = (m: CatalogModel) => !!m.coordinatorMode || (m.coordinatorMode === undefined && primary(m.provider));
    const hasPrimary = catalog.some(m => primary(m.provider) && hasMode(m));
    return (!hasPrimary || primary(provider)) && catalog.some(m => m.provider === provider && hasMode(m));
  }
  if (grade === "A" || grade === "B") {
    return primary(provider) || (!!catalog && !catalog.some(m => primary(m.provider)));
  }
  if (grade === "C" && provider === "grok") {
    return !!catalog && !catalog.some(m => m.provider !== "grok");
  }
  return true;
}

export function sameRoute(a: RouteChoice, b: RouteChoice) {
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

type Recommendation = [provider: string, model: string, effort: string];
const recommendations: Record<Grade, Recommendation[]> = {
  A: [["claude", "claude-fable-5-2", "xhigh"], ["claude", "claude-opus-5-5", "max"], ["codex", "gpt-6.2-astra", "xhigh"]],
  B: [["claude", "claude-fable-5-2", "high"], ["claude", "claude-opus-5-5", "xhigh"], ["codex", "gpt-6.2-astra", "high"]],
  C: [["claude", "claude-opus-5-5", "high"], ["codex", "gpt-6.2-sol", "high"], ["claude", "claude-sonnet-5-5", "high"]],
  D: [["claude", "claude-sonnet-5-5", "medium"], ["codex", "gpt-6-luna", "high"]],
  M: [["claude", "claude-opus-5-5", "high"], ["codex", "gpt-6.2-sol", "high"]],
};

function available(choice: RouteChoice, catalog: CatalogModel[]) {
  return catalog.some(m => m.provider === choice.provider && m.model === choice.model &&
    (choice.effort === null || m.efforts.includes(choice.effort)));
}

export function includedCatalog(catalog: CatalogModel[], excludedProviders: readonly string[]) {
  const excluded = new Set(excludedProviders);
  return catalog.filter(m => !excluded.has(m.provider));
}

export function validateCandidates(grade: Grade, candidates: RouteChoice[], catalog: CatalogModel[], saved: RouteChoice[] = []) {
  const seen: RouteChoice[] = [];
  for (const choice of candidates) {
    const retained = saved.some(prior => sameRoute(prior, choice));
    if (!retained && (!eligibleProvider(grade, choice.provider, false, catalog) || !available(choice, catalog))) {
      throw new Error("이 등급과 호스트에서 사용할 수 있는 실행기·모델·추론 강도를 선택해 주세요.");
    }
    if (seen.some(prior => sameRoute(prior, choice))) throw new Error("같은 배정 후보가 두 번 있습니다.");
    seen.push(choice);
  }
}

export function resolveRoute(grade: Grade, policy: RoutePolicy, catalog: CatalogModel[], needsHooks = false): RouteChoice | null {
  const providers = new Set(catalog.map(m => m.provider));
  for (const provider of providers) {
    if (!eligibleProvider(grade, provider, needsHooks, catalog)) providers.delete(provider);
  }
  const allowed = catalog.filter(m => providers.has(m.provider));
  const overrides = policy[grade];
  if (overrides) return overrides.find(choice => available(choice, allowed)) ?? null;
  for (const [provider, model, effort] of recommendations[grade]) {
    const match = allowed.find(m => m.provider === provider && m.model === model);
    if (match) return { provider, model, effort: match.efforts.includes(effort) ? effort : null };
  }
  const fallback = allowed.find(m => m.isDefault) ?? allowed[0];
  return fallback ? { provider: fallback.provider, model: fallback.model, effort: null } : null;
}
