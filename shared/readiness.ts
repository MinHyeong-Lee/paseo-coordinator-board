import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const boardReadiness = defineRpc({
  name: "board.readiness",
  input: z.strictObject({}),
  output: z.object({ configured: z.boolean(), coordinator: z.string().nullable() }),
});
export type BoardReadiness = z.output<typeof boardReadiness.output>;
