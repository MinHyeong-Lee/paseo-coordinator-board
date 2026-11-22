import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// GitHub.com owner/repository only. Keep remote credentials, paths and CLI flags out of settings.
export const repositorySlug = z.string().trim()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i)
  .refine(value => ![".", ".."].includes(value.split("/")[1]))
  .transform(value => value.toLowerCase());
export const repositoryMode = z.enum(["auto", "manual", "off"]);
export const repositoryOverride = z.discriminatedUnion("mode", [
  z.object({ mode:z.literal("manual"), repo:repositorySlug }), z.object({mode:z.literal("off")}),
]);
export const pullReason = z.enum(["ready","draft","conflict","checks-failed","checks-pending","changes-requested","blocked","unknown","auto-merge"]);
const pull = z.object({
  repo:repositorySlug, number:z.number().int().positive(), title:z.string(), url:z.string().url(),
  projectIds:z.array(z.string()), lane:z.enum(["review","progress"]), reason:pullReason, updatedAt:z.string(),
});
export const pullRequestViewSchema = z.object({
  items:z.array(pull),
  projects:z.array(z.object({
    projectId:z.string(), repo:repositorySlug.nullable(), mode:repositoryMode,
    status:z.enum(["ok","unmapped","unavailable","off","truncated"]),
  })),
});
export type PullRequestView = z.infer<typeof pullRequestViewSchema>;
export type PullRequestItem = z.infer<typeof pull>;
export const setProjectRepository = defineRpc({
  name:"board.set-project-repository",
  input:z.strictObject({
    projectId:z.string().min(1).max(4096), mode:repositoryMode, repo:repositorySlug.nullable().optional(),
    expectedMode:repositoryMode, expectedRepo:repositorySlug.nullable(),
  }).refine(input => input.mode === "manual" ? !!input.repo : !input.repo),
  output:z.object({ok:z.literal(true)}),
});
