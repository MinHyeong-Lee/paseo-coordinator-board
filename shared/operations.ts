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
  output: z.object({ sessionId: z.string(), workspaceId: z.string().nullable(), reused: z.boolean(), pinFailed: z.boolean().optional() }),
});
export const coordinatorPinSettings = defineRpc({
  name: "board.coordinator-pin-settings",
  input: z.strictObject({}),
  output: z.object({
    enabled: z.boolean(),
    workspace: z.object({ id: z.string(), coordinator: z.string(), title: z.string(), pinned: z.boolean() }).nullable(),
  }),
});
export const setCoordinatorAutoPin = defineRpc({
  name: "board.set-coordinator-auto-pin",
  input: z.strictObject({ enabled: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});
export const pinCurrentCoordinator = defineRpc({
  name: "board.pin-current-coordinator",
  input: z.strictObject({ coordinator: z.string().min(1), workspaceId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});
export type CoordinatorPinSettings = z.output<typeof coordinatorPinSettings.output>;
const messageFields = { coordinator: z.string().min(1).max(256), requestKey: z.string().min(12).max(96) };
export const askDigest = defineRpc({
  name: "board.request-digest",
  input: z.strictObject({ ...messageFields, language: z.enum(["ko", "en"]).optional(), handleBoardFacts: z.boolean().optional() }),
  output: z.object({ ok: z.boolean() }),
});
export const WORK_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_WORK_IMAGES = 4;
export const MAX_WORK_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_WORK_IMAGES_BYTES = 12 * 1024 * 1024;
const workImage = z.strictObject({
  mimeType: z.enum(WORK_IMAGE_MIME_TYPES),
  data: z.string().min(4).max(4 * Math.ceil(MAX_WORK_IMAGE_BYTES / 3)),
});
export type WorkImage = z.infer<typeof workImage>;

function decodedLength(data: string) {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

export const requestWork = defineRpc({
  name: "board.request-work",
  input: z.strictObject({
    ...messageFields,
    text: z.string().trim().max(24000),
    images: z.array(workImage).max(MAX_WORK_IMAGES).optional(),
  }).refine(({text, images}) => !!text || !!images?.length, "Provide text or a photo.")
    .refine(({images}) => {
      const sizes = images?.map(image => decodedLength(image.data)) ?? [];
      return sizes.every(size => size <= MAX_WORK_IMAGE_BYTES) && sizes.reduce((a,b) => a + b, 0) <= MAX_WORK_IMAGES_BYTES;
    }, "Photo size exceeds the request limit."),
  output: z.object({ ok: z.boolean() }),
});
export type Operations = z.output<typeof operationState.output>;
