import type { Translate } from "./language";
import { sessionDetail, type Card } from "./model";

// Older coordinator reports combine status, evidence and the question in one text field.
function excerptQuestion(text: string) {
  const lines = text
    .replace(/^```[^\n]*\n[\s\S]*?(?:^```[^\n]*$|(?![\s\S]))/gm, "")
    .split(/\r?\n/)
    .filter(line => !/^\s*>/.test(line))
    .map(line => line.trim().replace(/^[-*•]\s+/, "").replace(/\*\*/g, ""))
    .filter(Boolean);
  const marker = /(?:^|[\s;·|—])(?:결정\s*필요|내\s*결정|정할\s*(?:일|것)|결정\s*요청|질문|decision\s+(?:needed|required)|question)\s*[:：]\s*/i;
  for (const [index, line] of lines.entries()) {
    const match = marker.exec(line);
    if (!match) continue;
    const after = line.slice(match.index + match[0].length).trim() || lines[index + 1] || "";
    if (after) return after.split(/(?<=[?？])\s|\s+(?=(?:근거|상태|배경|다음 단계|evidence|status|context)\s*[:：])/i)[0];
  }
  // Select an actual question without including a preceding status sentence or changing its words.
  for (const line of lines) {
    const question = line.split(/(?<=[.!。])\s+/).find(sentence => /[?？]/.test(sentence));
    if (question) return question.slice(0, question.search(/[?？]/) + 1);
  }
  return lines[0] || "";
}

export function decisionSummary({ session, note }: Card, t: Translate) {
  const decision = session.decision;
  const question = decision?.question || (note?.kind === "question" && note.text) || session.detail;
  const formal = !!session.nativePending || decision?.source === "permission";
  const raw = question.replace(/^(?:코디네이터 판단|세션의 확인 요청) · /, "");
  const headline = formal ? sessionDetail(question, t) : excerptQuestion(raw);
  const normalize = (text: string) => text.replace(/^(?:코디네이터 판단|세션의 확인 요청) · /, "").trim();
  const evidence: string[] = [];
  for (const text of [question, session.detail, note?.kind !== "clear" && note?.text]) {
    if (text && !evidence.some(prior => normalize(prior) === normalize(text))) evidence.push(text);
  }
  return {
    formal,
    headline: headline || t("원래 세션에서 정할 내용을 확인하세요.", "Open the session to review the decision."),
    evidence,
  };
}
