import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import { PreferenceStore } from "./preferences";

export const digestPrompt =
  "관리 중인 프로젝트의 다이제스트를 한국어로 갱신해 주세요. read_board_conversation으로 최근 발췌를 확인하고 그 근거에 따라 classify_board_conversation으로 판단을 기록하세요. 지금 내가 직접 결정할 항목과 그 근거를 먼저 알려 주세요. 질문과 추천, 선택지가 근거에 있으면 content에 각각 기록하고 근거가 없는 선택지는 생략하세요. 이번 요청은 조회와 분류만 맡깁니다.";
export const englishDigestPrompt =
  "Refresh the digest for managed projects in English. Use read_board_conversation to inspect recent excerpts and classify_board_conversation to record judgments grounded in them. Start with the decisions I need to make and the evidence for each one. Include a question, recommendation, or options in content only when supported by the conversation. Keep quoted messages in their original language. This request is limited to reading and classification.";
export async function sendCoordinatorRequest(
  paseo: PluginHandlerContext["paseo"],
  store: PreferenceStore,
  expected: string,
  key: string,
  text: string,
) {
  if (store.read().coordinator !== expected) throw new Error("현재 코디네이터를 다시 확인해 주세요.");
  if (!store.read().projects.length) throw new Error("관리할 프로젝트를 하나 이상 선택하세요.");
  const handle = paseo.agents.ref(expected);
  const snapshot = (await handle.refresh())?.agent;
  if (
    !snapshot ||
    snapshot.archivedAt ||
    snapshot.status !== "idle" ||
    snapshot.activeTurn ||
    snapshot.pendingPermissions.length
  ) {
    throw new Error("코디네이터가 대기 상태일 때 요청할 수 있습니다. 세션에서 현재 작업을 확인하세요.");
  }
  if (store.read().coordinator !== expected) throw new Error("코디네이터가 교체되었습니다. 새로 고쳐 주세요.");
  if (!store.read().projects.length) throw new Error("관리 프로젝트가 변경되었습니다.");
  const id = createHash("sha256")
    .update(JSON.stringify([expected, key, text]))
    .digest("hex");
  const messageId = [
    id.slice(0, 8),
    id.slice(8, 12),
    "4" + id.slice(13, 16),
    "8" + id.slice(17, 20),
    id.slice(20, 32),
  ].join("-");
  await handle.send(text, { messageId, activeTurnBehavior: "steer" });
  return { ok: true };
}
