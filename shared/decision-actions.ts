import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const decisionFields = z.object({
  question: z.string().trim().min(1).max(2000).optional(),
  recommendation: z.string().trim().min(1).max(2000).optional(),
  recommendationReason: z.string().trim().min(1).max(400).optional(),
  needsInput: z.string().trim().min(1).max(400).optional(),
  options: z.array(z.object({
    label: z.string().trim().min(1).max(160), reply: z.string().trim().min(1).max(2000),
  })).max(10).optional(),
});
export const decisionSchema = decisionFields.extend({
  question: z.string().min(1),
  version: z.string().min(1).max(64),
  source: z.enum(["permission", "conversation", "coordinator", "agent-note", "person-note"]),
});
export type Decision = z.output<typeof decisionSchema>;

const id = z.string().min(1).max(256);
export const sendDecision = defineRpc({
  name: "board.send-decision",
  input: z.strictObject({
    projectId: z.string().min(1).max(4096), sessionId: id, recipientId: id,
    version: z.string().min(1).max(64),
    action: z.enum(["reply", "question", "coordinate"]),
    text: z.string().min(1).max(24000).refine(text => text.trim().length > 0),
    requestKey: z.string().min(12).max(96).regex(/^[A-Za-z0-9_-]+$/),
  }),
  output: z.object({ ok: z.literal(true), recipientId: id, messageId: z.string().uuid() }),
});
export type DecisionInput = z.input<typeof sendDecision.input>;
