import { expect, test } from "bun:test";
import { decisionSummary } from "../client/decision-summary";
import { factStatus, type Card } from "../client/model";

const ko = (text: string) => text;
const en = (_: string, text: string) => text;
function card(detail: string): Card {
  return { session: { id: "sample", title: "Draft", projectId: "p", projectTitle: "Studio", workspaceTitle: "Planning", model: null, lane: "human", detail }, lane: "human", note: undefined };
}

test("a labelled decision inside an old status report keeps the original wording and full evidence", () => {
  const original = "빌드가 끝났습니다. 증거: 9개의 링크가 열립니다. 결정 필요: 공개일을 목요일로 할까요? 근거: 촬영팀이 대기 중입니다.";
  const row = card("코디네이터 판단 · " + original);
  expect(decisionSummary(row, ko)).toEqual({ formal: false, headline: "공개일을 목요일로 할까요?", evidence: [row.session.detail] });
  const next = card("Results ready. Decision needed: Choose a licence. Evidence: Legal review complete.");
  expect(decisionSummary(next, en).headline).toBe("Choose a licence.");
});

test("question choice skips quoted and fenced examples, and keeps a structured recommendation separate", () => {
  const question = "> Question: Quoted example?\n```\nDecision needed: Demo?\n```\n**정할 일:**\n- 어떤 자막을 사용할까요?\n대안 두 가지가 있습니다.";
  const row = card("");
  row.session.decision = { source: "coordinator", question, recommendation: "기존 자막을 사용해 주세요.", version: "v-2" };
  const result = decisionSummary(row, ko);
  expect(result.headline).toBe("어떤 자막을 사용할까요?");
  expect(result.evidence).toEqual([question]);
  expect(result.headline).not.toContain("기존 자막");
});

test("unlabelled questions and native permissions retain their sources, and empty text creates no answer", () => {
  expect(decisionSummary(card("The cut is ready. Which take should we use? More details follow."), en).headline).toBe("Which take should we use?");
  expect(decisionSummary(card(""), en).headline).toContain("Open the session");
  const gated = card("응답을 기다리는 요청 2건"); gated.session.nativePending = true;
  expect(decisionSummary(gated, en)).toEqual({ formal: true, headline: "Requests awaiting a response: 2", evidence: ["응답을 기다리는 요청 2건"] });
});

test("delivery labels distinguish a recorded fact and confirmed delivery in both languages", () => {
  const states = ["recorded", "pending", "sent", "unconfirmed"] as const;
  expect(states.map(s => factStatus({ delivery: s, kind: "status" }, en))).toEqual(["Fact recorded", "Checking delivery of fact", "Fact delivered", "Fact delivery unconfirmed"]);
  expect(new Set(states.map(s => factStatus({ delivery: s, kind: "status" }, ko))).size).toBe(4);
  expect(factStatus({ delivery: "recorded", kind: "report" }, en)).toBe("Progress report recorded");
  expect(factStatus({ delivery: "recorded", kind: "report" }, ko)).toBe("진행 보고 기록됨");
});
