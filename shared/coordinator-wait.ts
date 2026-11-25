import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import { splitQuestionBlock } from "./question-block";
import { asksForDecision, unquoted } from "./question-request";
import { cleanSessionText } from "./review-wait";

const reasons = {
  screen: ["화면 차례", "Screen access"],
  decision: ["판단", "Decision"],
  merge: ["병합", "Merge"],
  report: ["보고에 대한 답", "Reply to report"],
  reply: ["코디네이터 답", "Coordinator reply"],
} as const;
export type CoordinatorWaitReason = keyof typeof reasons;
export type CoordinatorWait = { reason: CoordinatorWaitReason; since?: string };
type Translate = (ko: string, en: string) => string;

export const coordinatorWaitReasons = Object.keys(reasons) as CoordinatorWaitReason[];
const longWait = 30 * 60_000;

export function coordinatorWaitLabel(reason: CoordinatorWaitReason, t: Translate) {
  const [ko, en] = reasons[reason];
  return t("코디네이터 대기", "Waiting on coordinator") + " · " + t(ko, en);
}

export function isLongCoordinatorWait(since: string | undefined, now: number) {
  return now - Date.parse(since ?? "") >= longWait;
}

const koreanTarget = /코디네이터|(?:다른|동료|병렬|작업|설계|담당)\s*세션/iu;
const englishTarget = /\b(?:coordinator|(?:another|other|peer|parallel|worker|design|work) (?:session|agent))\b/i;
const englishDependency = new RegExp(`^(?:(?:a|an|the|my|our)\\s+)?(?:(?:reply|response|approval|decision|feedback|go-ahead)\\s+from\\s+(?:the\\s+)?)?${englishTarget.source}`, "i");
const koreanWaiting = /기다리(?:고|겠|는)|기다립|대기(?!열)|(?:오면|받으면|나오면|주면|되면)\s*(?:다시\s*)?(?:이어|계속|재개|진행|시작)/u;
const koreanReplyWord = /답변?|회신|응답|승인|판단|결정|병합|화면\s*(?:사용\s*)?(?:차례|허락|승인)/u;
const koreanWaitVerb = /기다리(?:고|겠|는)|기다립|대기|오면|받으면|나오면|되면/u;
const koreanDependency = new RegExp(
  `(?:${koreanTarget.source})(?:(?:의|에게서|한테서|로부터)?\\s*(?:${koreanReplyWord.source})(?:을|를|이|가)?|(?:을|를)?)\\s*(?:${koreanWaitVerb.source})|` +
  `(?:${koreanTarget.source})(?:가|이)?\\s+(?:${koreanReplyWord.source})(?:을|를)?\\s*(?:주면|해\\s*주면)`,
  "u",
);
const reportClauseEnd = /(?:보고|전달|문의|공유)(?:드렸고|했고|했으며|했습니다|한 뒤)\s*[,，]?\s*|[,，]\s*/u;
const koreanImplicitReply = /^(?:(?:라는|는|그)\s+)?(?:답변?|회신|응답|화면\s*사용\s*(?:승인|허락))(?:을|를|이|가)?\s*(?:기다리|기다립|대기|오면|받으면)/u;
const englishWaiting = /\b(?:wait(?:ing)? (?:for|on|until)|await(?:ing)?|(?:blocked|paused|on hold) (?:on|until|pending)|(?:resume|continue|proceed)\b.*\b(?:once|when|after))\b/i;
const reply = /\b(?:its|their|a|the)\s+(?:reply|response|go-ahead|approval|decision|confirmation)\b|(?:답변?|회신|응답|승인|판단)(?:을|를|이|가)?\s*(?:기다리|기다립|대기|오면|받으면)/iu;
const report = /보고|\b(?:report|reported|update|briefed)\b/iu;
const screen = /화면\s*(?:차례|사용|공유|확인|검증)|\bscreen\s+(?:access|time|turn|slot|permission|clearance)\b/iu;
const koreanScreenTurn = /^(?:(?:저는|현재|지금|아직|이제)\s+)*화면\s*차례(?:를|가)?\s*(?:기다리|기다립|대기|오면)/u;
const englishScreenTurn = /^(?:(?:a|the|my|our)\s+)?(?:screen\s+(?:turn|slot)|visual (?:check|QA) slot)\b/i;
const decision = /판단|결정|승인|\b(?:decision|approval|review|verdict)\b/iu;
const merge = /병합|\bmerg(?:e[sd]?|ing)\b/iu;
const resolved = /기다리지\s*(?:않|말)|대기(?:하지\s*않|가?\s*끝)|(?:답변?|회신|승인|화면\s*차례)(?:을|를)?\s*받았|\b(?:not|never|no longer|was|were)\s+waiting\b|\b(?:already|has|have|just)\s+(?:replied|responded|approved|merged)\b/i;

// Keep decisions in prose. Markdown examples can contain sentences that
// look like either a request to the user or a wait.
function prose(text: string) {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of cleanSessionText(text).split("\n")) {
    if (line.trimStart().startsWith(">")) continue;
    if (fence) {
      const trimmed = line.trim();
      if (trimmed.startsWith(fence) && !trimmed.replaceAll(fence[0], "")) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (opening) {
      fence = opening;
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) continue;
    lines.push(line.replace(/(`+)[^`]*\1/g, ""));
  }
  return lines;
}

export function detectCoordinatorWait(text: string): CoordinatorWaitReason | undefined {
  const lines = prose(text);
  if (lines.some(asksForDecision)) return undefined;

  let reason: CoordinatorWaitReason | undefined;
  let reported = false;
  for (const line of lines) {
    const body = unquoted(line).replace(/[*_]/g, " ");
    for (const sentence of body.split(/(?<=[.!?。！？])\s+/u)) {
      const koWaiting = koreanWaiting.test(sentence);
      const enWaiting = englishWaiting.exec(sentence);
      const dependency = enWaiting ? sentence.slice(enWaiting.index + enWaiting[0].length).trim() : "";
      const koTarget = koreanTarget.test(sentence);
      const mentionsTarget = koTarget || englishTarget.test(sentence);
      const sentReport = mentionsTarget && report.test(sentence);
      if (resolved.test(sentence)) {
        if (mentionsTarget || reply.test(sentence) || screen.test(sentence)) reason = undefined;
      } else if (englishScreenTurn.test(dependency)) {
        reason = "screen";
      } else if ((koWaiting || enWaiting) && (
        (koWaiting && koreanDependency.test(sentence)) ||
        englishDependency.test(dependency) ||
        (koWaiting && koreanScreenTurn.test(sentence.replace(/^\s*(?:[-+•]\s+)?/, ""))) ||
        ((reported || sentReport) && (enWaiting ? reply.test(dependency)
          : koreanImplicitReply.test(sentence.split(reportClauseEnd).at(-1)?.trim() ?? "")))
      )) {
        reason = screen.test(sentence) ? "screen" : merge.test(sentence) ? "merge" : decision.test(sentence) ? "decision"
          : sentReport || reported ? "report" : "reply";
      }
      if (sentence.trim()) reported = sentReport;
    }
  }
  return reason;
}

type TimelineEntry = Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>["entries"][number];

export function coordinatorWaitInTimeline(entries: readonly TimelineEntry[]): CoordinatorWait | undefined {
  const latest = entries.findLast(({ item }) =>
    item.type === "user_message" ||
    (item.type === "assistant_message" && item.text.trim()) ||
    (item.type === "tool_call" && (item.agentMessage || item.name === "heartbeat")));
  if (latest?.item.type !== "assistant_message") return;
  const reason = detectCoordinatorWait(latest.item.text);
  if (reason && !splitQuestionBlock(latest.item.text).block) return { reason, since: latest.timestamp };
}
