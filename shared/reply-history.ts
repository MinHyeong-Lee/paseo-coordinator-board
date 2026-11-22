import { z } from "zod";

export const replyDetails = z.object({
  title: z.string(), projectId: z.string().nullable(), answer: z.string().optional(),
  at: z.string().datetime(), recipientId: z.string().optional(), coordinator: z.boolean().optional(),
});

export const replyEntry = replyDetails.extend({
  key: z.string(), status: z.enum(["sent", "pending", "recorded", "closed"]),
  messageId: z.string().optional(), response: z.string().optional(),
  recipientTitle: z.string().optional(), recipientState: z.enum(["running","idle","closed","error","unknown"]).optional(),
  canOpen: z.boolean().optional(),
});
export type ReplyEntry = z.output<typeof replyEntry>;
