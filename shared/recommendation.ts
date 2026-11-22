import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { sendDecision } from "./decision-actions";

export const requestRecommendation = defineRpc({
  name: "board.request-recommendation",
  input: sendDecision.input.pick({
    projectId: true, sessionId: true, version: true, requestKey: true,
  }).extend({
    coordinator: z.string().min(1).max(256),
    language: z.enum(["ko", "en"]),
  }),
  output: sendDecision.output,
});
