import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { boardDecisionCount } from "../shared/contract";
import type { Theme } from "./controls";
import { useBoardLanguage } from "./language";

type CountUpdate = (host: string, count: number) => void;
const listeners = new Set<CountUpdate>();
export function publishDecisionCount(host: string, count: number) {
  for (const update of listeners) update(host, count);
}

export function DecisionBadge({host, theme}: {host: string; theme: Theme}) {
  const { t } = useBoardLanguage();
  const rpc = useRpc(boardDecisionCount);
  const read = useRef(rpc);
  read.current = rpc;
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    let pending = false;
    let revision = 0;
    setCount(null);
    const fromBoard: CountUpdate = (id, total) => {
      if (id === host) { revision++; setCount(total); }
    };
    const poll = async () => {
      if (pending) return;
      const at = revision;
      pending = true;
      try {
        const result = await read.current({});
        if (active && at === revision) setCount(result.count);
      } catch {
        if (active && at === revision) setCount(null);
      } finally { pending = false; }
    };
    listeners.add(fromBoard);
    void poll();
    const timer = setInterval(() => void poll(), 30_000);
    return () => { active = false; clearInterval(timer); listeners.delete(fromBoard); };
  }, [host]);
  const c = theme.colors;
  return <Text accessibilityLabel={count === null ? t("내 결정 건수 미확인", "Decision count unavailable") : t(`내 결정 ${count}건`, `${count} pending decisions`)}
    style={{minWidth: 20, borderRadius: 10, overflow: "hidden", textAlign: "center", fontSize: 12, fontWeight: "600", paddingHorizontal: 5,
      color: count ? c.accentForeground : c.foregroundMuted, backgroundColor: count ? c.accent : "transparent"}}>{count ?? "–"}</Text>;
}
