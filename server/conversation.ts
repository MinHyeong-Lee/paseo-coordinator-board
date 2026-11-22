import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { SessionRow } from "../shared/contract";
import type { Preferences } from "./preferences";

type Sdk = PluginHandlerContext["paseo"];
type Page = Awaited<ReturnType<ReturnType<Sdk["agents"]["ref"]>["timeline"]["refetch"]>>;
export type Turn = { role: "user" | "assistant"; text: string };
type Evidence = { id: string; turns: Turn[] };
type Candidate = Pick<SessionRow, "lane" | "detail">;
const request = /확인해\s*주실\s*것|(?:확인|선택|승인|결정|답변|지정)\s*(?:부탁드|해\s*(?:주세|주실|주셔야|주시겠))|(?:알려|골라|정해|답해)\s*(?:주세|주실|주셔야)|(?:할까요|될까요|하시겠어요|고르시겠어요|원하시나요)[?？]|\b(?:please (?:choose|confirm|approve)|which .* (?:prefer|choose)|shall I|would you like me to|could you (?:confirm|choose))\b/i;
const optionalOffer = /(?:궁금|필요|원하).{0,12}(?:시면|시다면|면).{0,25}(?:알려|말씀|도와)|\b(?:if you (?:like|want)|let me know if)\b/i;

export function excerpt(page: Page): Evidence {
  if (page.error || page.gap || page.staleCursor) throw new Error("대화 발췌를 확인할 수 없습니다.");
  const turns: Turn[] = [];
  const digest = createHash("sha256").update(page.epoch);
  for (const { item, seqEnd } of page.entries) {
    if (item.type !== "assistant_message" && item.type !== "user_message") continue;
    const role = item.type === "assistant_message" ? "assistant" : "user";
    const text = item.text.trim();
    if (!text) continue;
    turns.push({ role, text: text.slice(-2000) });
    digest.update(JSON.stringify([seqEnd, role, text]));
  }
  return { id: digest.digest("hex").slice(0, 24), turns: turns.slice(-4) };
}

const noQuestion = /(?:확인해\s*주실\s*것|결정해\s*주실\s*것|확인\s*요청)(?:은|이|이란)?\s*(?:없|없습니다|없음)/;

function questionIn(text: string) {
  const lines = text.replace(/^```[\s\S]*?^```[^\n]*/gm, "").split("\n").map(line => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(">") || noQuestion.test(lines[i]) || optionalOffer.test(lines[i]) || !request.test(lines[i])) continue;
    // Include the checklist or options after a request heading.
    return lines.slice(i).filter(line => line && !line.startsWith(">")).join(" ").slice(0, 340);
  }
  return null;
}

export function classify(e: Evidence, row: SessionRow, decision?: Preferences["judgments"][string]): Candidate {
  if (row.lane === "human" || row.lane === "running" || row.lane === "unknown" || row.detail.includes("오류")) return row;
  if (decision?.evidenceId === e.id) {
    return { lane: decision.kind === "question" ? "human" : decision.kind, detail: "코디네이터 판단 · " + decision.text };
  }
  const last = e.turns.at(-1);
  if (!last) return row;
  if (last.role === "assistant") {
    const question = questionIn(last.text);
    if (question) return { lane: "human", detail: "세션의 확인 요청 · " + question };
  } else {
    const previous = e.turns.slice(0, -1).findLast(t => t.role === "assistant");
    if (previous && questionIn(previous.text)) {
      return { lane: "review", detail: "질문 뒤에 메시지가 왔습니다. 같은 질문에 대한 답인지 확인하세요." };
    }
  }
  return row;
}

export class ConversationReader {
  private readonly cache = new Map<string, { stamp: string; at: number; page: Promise<Evidence> }>();

  retain(ids: Set<string>) {
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
  }

  async read(paseo: Sdk, row: SessionRow, fresh = false): Promise<Evidence | null> {
    const cached = this.cache.get(row.id);
    if (row.status === "closed") {
      return cached?.stamp === row.activityAt ? cached?.page ?? null : null;
    }
    if (row.status !== "idle" && row.status !== "error") return null;
    if (!fresh && cached && cached.stamp === row.activityAt && Date.now() - cached.at < 60_000) return cached.page;
    const page = paseo.agents.ref(row.id).timeline.refetch({ direction: "tail", projection: "projected", limit: 48 }).then(excerpt);
    this.cache.set(row.id, { stamp: row.activityAt ?? "", at: Date.now(), page });
    try { return await page; }
    catch (error) {
      if (this.cache.get(row.id)?.page === page) this.cache.delete(row.id);
      throw error;
    }
  }

  async decorate(paseo: Sdk, rows: SessionRow[], prefs: Preferences) {
    this.retain(new Set(rows.map(row => row.id)));
    let cursor = 0;
    const work = async () => {
      while (cursor < rows.length) {
        const row = rows[cursor++];
        try {
          const evidence = await this.read(paseo, row);
          if (evidence && row.lane !== "human" && (row.lane === "idle" || row.lane === "review") && !row.detail.includes("오류")) {
            Object.assign(row, classify(evidence, row, prefs.judgments[row.id]), { evidenceId: evidence.id });
          }
        } catch {
          row.detail += " · 최근 대화 조회 실패";
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, work));
  }
}
