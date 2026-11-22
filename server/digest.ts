import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import { PreferenceStore } from "./preferences";
import type { WorkImage } from "../shared/operations";

const prompts = {
  ko: "관리 프로젝트의 다이제스트를 한국어로 갱신하세요. read_board_conversation에서 최근 근거를 확인하고 classify_board_conversation으로 기록하세요. 각 질문에는 당사자가 정할 한 문장을 content.question에 적으세요. 근거·기존 기준에서 제안할 수 있는 가장 타당한 답장 하나를 content.recommendation에, 간단한 이유를 content.recommendationReason에 적으세요. 증거에 실제 답장 문장이 없어도 근거 있는 제안은 작성할 수 있습니다. 판단에 필요한 정보가 부족하면 결정을 지어내지 말고 필요한 정보를 content.needsInput에 적으세요. 예전에 판단한 질문도 needsRecommendation이 표시되면 갱신하세요. 진행 보고와 이미 정해진 사항은 내 결정에서 내리고, 직접 결정할 안건을 먼저 보고하세요.",
  en: "Refresh the digest for managed projects in English. Inspect recent evidence with read_board_conversation and use classify_board_conversation to record your findings. For every genuine human decision, write one short question in content.question. When evidence or an established preference supports it, propose one editable, ready-to-send reply in content.recommendation and give a brief reason in content.recommendationReason. The proposed wording may be new. If essential input is missing, name it in content.needsInput without inventing the person's choice. Revisit earlier decisions marked needsRecommendation. Keep progress reports and resolved matters out of My decisions, and report the remaining decisions first.",
};

export const digestPrompt = prompts.ko + " 이번 요청은 조회와 분류만 맡깁니다.";
export const englishDigestPrompt = prompts.en + " Limit this request to reading and classification.";

export function digestWithFactReplies(language: "ko" | "en", cycleId: string) {
  const instructions = language === "ko"
    ? "이번 다이제스트에서 보드가 단독 사실 질문으로 식별한 세션에는 answer_board_fact로 답하세요. 이 도구가 허용한 대상·근거에 대해서만 코디네이터 이름으로 확인된 사실을 보낼 수 있습니다. 다른 방식의 메시지 전송은 요청하지 않았습니다. 처리 결과와 사람이 결정할 안건을 구분하세요."
    : "For this digest, call answer_board_fact for standalone factual questions identified by the board. Only that tool may send its verified facts as the coordinator. Do not send a message by any other route. Report handled items separately from human decisions.";
  return prompts[language] + " " + instructions + " " + JSON.stringify({ cycleId });
}

function photoDigest({data, mimeType}: WorkImage) {
  // Buffer's base64 decoder accepts malformed input. Require the original canonical
  // encoding, then identify the file bytes independently of the picker-supplied MIME.
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new Error("사진의 Base64 데이터를 확인해 주세요.");
  const pngHeader = "89504e470d0a1a0a0000000d49484452";
  const valid = mimeType === "image/png" ? bytes.length >= 33 && bytes.toString("hex", 0, 16) === pngHeader
    : mimeType === "image/jpeg" ? bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : bytes.length >= 20 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP" &&
      ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("latin1", 12, 16));
  if (!valid) throw new Error("사진 데이터와 파일 형식이 일치하는지 확인해 주세요.");
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sendCoordinatorRequest(
  paseo: PluginHandlerContext["paseo"],
  store: PreferenceStore,
  expected: string,
  key: string,
  text: string,
  options: {
    images?: WorkImage[];
    beforeSend?: (messageId: string) => void;
  } = {},
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
  const images = options.images;
  const content = images?.length ? [expected, key, text, images.map(photoDigest)] : [expected, key, text];
  const id = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  const messageId = [
    id.slice(0, 8),
    id.slice(8, 12),
    "4" + id.slice(13, 16),
    "8" + id.slice(17, 20),
    id.slice(20, 32),
  ].join("-");
  options.beforeSend?.(messageId);
  await handle.send(text, { messageId, activeTurnBehavior: "steer", ...(images?.length ? {images} : {}) });
  return { ok: true };
}
