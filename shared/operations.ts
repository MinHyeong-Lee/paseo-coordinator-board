import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { catalogModelSchema, providerEntrySchema, gradeSchema, routeChoiceSchema, routePolicySchema } from "./dispatch";

export const operationState = defineRpc({
  name: "board.operations",
  input: z.strictObject({}),
  output: z.object({
    catalog: z.array(catalogModelSchema),
    providers: z.array(providerEntrySchema),
    coordinatorMode: z.object({ id: z.string(), label: z.string() }).nullable(),
    routing: routePolicySchema,
    revision: z.number().int().nonnegative(),
  }),
});
export const setProviderInclusion = defineRpc({
  name: "board.set-provider-inclusion",
  input: z.strictObject({
    provider: z.string().min(1).max(256), included: z.boolean(), expectedRevision: z.number().int().nonnegative(),
  }),
  output: z.object({ ok: z.boolean() }),
});
export const updateRouting = defineRpc({
  name: "board.update-routing",
  input: z.strictObject({
    grade: gradeSchema,
    candidates: z.array(routeChoiceSchema).max(12),
    expectedRevision: z.number().int().nonnegative(),
  }),
  output: z.object({ ok: z.boolean() }),
});
export const setupCoordinator = defineRpc({
  name: "board.setup-coordinator",
  input: z.strictObject({
    replace: z.boolean(),
    expectedCoordinator: z.string().nullable(),
    expectedRoute: routeChoiceSchema,
    expectedModeId: z.string().min(1).optional(),
  }),
  output: z.object({ sessionId: z.string(), workspaceId: z.string().nullable(), reused: z.boolean() }),
});
const messageFields = { coordinator: z.string().min(1).max(256), requestKey: z.string().min(12).max(96) };
export const askDigest = defineRpc({
  name: "board.request-digest",
  input: z.strictObject(messageFields),
  output: z.object({ ok: z.boolean() }),
});
export const requestWork = defineRpc({
  name: "board.request-work",
  input: z.strictObject({ ...messageFields, text: z.string().trim().min(1).max(24000) }),
  output: z.object({ ok: z.boolean() }),
});
export type Operations = z.output<typeof operationState.output>;
