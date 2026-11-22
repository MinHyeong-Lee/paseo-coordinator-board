import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { coordinatorPinSettings, pinCurrentCoordinator, setCoordinatorAutoPin, type CoordinatorPinSettings } from "../shared/operations";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

export function CoordinatorPinControls({ theme, coordinator }: { theme: Theme; coordinator: string | null }) {
  const { t } = useBoardLanguage();
  const read = useRpc(coordinatorPinSettings);
  const setEnabled = useRpc(setCoordinatorAutoPin);
  const pin = useRpc(pinCurrentCoordinator);
  const latestRead = useRef(read);
  latestRead.current = read;
  const revision = useRef(0);
  const [value, setValue] = useState<CoordinatorPinSettings | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);

  async function refresh(action?: () => Promise<unknown>) {
    const token = ++revision.current;
    setBusy(true);
    setError(false);
    try {
      if (action) await action();
      const next = await latestRead.current({});
      if (revision.current === token) setValue(next);
    } catch {
      if (revision.current === token) { setValue(null); setError(true); }
    } finally {
      if (revision.current === token) setBusy(false);
    }
  }
  useEffect(() => {
    setValue(null);
    void refresh();
    return () => { revision.current++; };
  }, [coordinator]);

  const target = value?.workspace?.coordinator === coordinator ? value.workspace : null;
  const c = theme.colors;
  return <View style={{ gap: 8, padding: 14, borderRadius: 10, backgroundColor: c.surface1 }}>
    <Text accessibilityRole="header" style={{ color: c.foreground, fontWeight: "600", fontSize: 17 }}>{t("사이드바 고정", "Sidebar pinning")}</Text>
    <Text style={{ color: c.foregroundMuted }}>{t("새 운영 워크스페이스를 이 호스트의 사이드바에 자동으로 고정합니다. 같은 공간에서 코디네이터만 교체하면 기존 고정 상태를 따릅니다.", "Automatically pin a new coordinator workspace in this host’s sidebar. Replacing the coordinator in the same workspace preserves its pin state.")}</Text>
    {value && <View style={{ alignItems: "flex-start" }}><Button theme={theme} selected={value.enabled} disabled={busy}
      label={value.enabled ? t("자동 고정 켜짐 · 끄기", "Auto-pin on · Turn off") : t("자동 고정 꺼짐 · 켜기", "Auto-pin off · Turn on")}
      onPress={() => void refresh(() => setEnabled({ enabled: !value.enabled }))} /></View>}
    {target && <Text style={{ color: c.foreground }}>{target.title} · {target.pinned ? t("사이드바에 고정됨", "Pinned in sidebar") : t("고정 해제됨", "Unpinned")}</Text>}
    {value && coordinator && !target && <Text style={{ color: c.foregroundMuted }}>{t("현재 코디네이터의 운영 워크스페이스를 확인할 수 없습니다.", "The current coordinator workspace is unavailable.")}</Text>}
    {error && <Text accessibilityLiveRegion="polite" style={{ color: c.statusDanger }}>{t("고정 상태를 확인할 수 없습니다. 새로 고침 후 다시 시도하세요.", "Could not confirm the pin state. Refresh and try again.")}</Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {target && !target.pinned && <Button theme={theme} disabled={busy} label={t("현재 운영 워크스페이스 고정", "Pin current coordinator workspace")}
        onPress={() => void refresh(() => pin({ coordinator: target.coordinator, workspaceId: target.id }))} />}
      {(error || coordinator) && <Button theme={theme} disabled={busy} label={t("고정 상태 새로 고침", "Refresh pin state")} onPress={() => void refresh()} />}
    </View>
  </View>;
}
