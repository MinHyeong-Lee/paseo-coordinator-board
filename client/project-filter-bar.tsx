import { defineSettings } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { z } from "zod";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { visibleProjectFilters, type ProjectFilter } from "./project-filters";

const preference = defineSettings({
  id: "project-filter-view", scope: "device", version: 1,
  schema: z.object({ expanded: z.boolean().default(false) }),
});

type Props = {
  groups: ProjectFilter[];
  selected: ReadonlySet<string | null>;
  total: number;
  clear: () => void;
  toggle: (group: ProjectFilter) => void;
  theme: Theme;
};

export function ProjectFilterBar({ groups, selected, total, clear, toggle, theme }: Props) {
  const { t } = useBoardLanguage();
  const saved = useSettings(preference);
  const [temporary, setTemporary] = useState<boolean | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const expanded = temporary ?? (saved.status === "ready" && saved.values.expanded);
  const { visible, hiddenCount } = visibleProjectFilters(groups, selected, expanded);

  async function setExpanded(next: boolean) {
    setTemporary(next);
    setSaveFailed(false);
    if (saved.status === "ready" && await saved.save({ expanded: next }, saved.revision)) {
      setTemporary(null);
    } else {
      setSaveFailed(true);
      await saved.reload();
    }
  }

  const label = t("프로젝트 필터", "Project filters");
  const all = <Button theme={theme} label={t(`전체 ${total}`, `All ${total}`)} singleLine selected={!selected.size} onPress={clear} />;
  const expand = <Button theme={theme} expanded={expanded} singleLine disabled={saved.saving}
    label={expanded ? t("접기 ▴", "Collapse ▴") : t(`+${hiddenCount}개 ▾`, `+${hiddenCount} more ▾`)}
    accessibilityLabel={expanded ? t("프로젝트 필터 접기", "Collapse project filters")
      : t(`프로젝트 필터 ${hiddenCount}개 더 보기`, `Show ${hiddenCount} more project filters`)}
    onPress={() => void setExpanded(!expanded)} />;
  const chips = visible.map(group => <View key={JSON.stringify(group.ids)} style={{ maxWidth: expanded ? "100%" : 190 }}>
    <Button theme={theme} toggle singleLine={!expanded} selected={group.ids.some(id => selected.has(id))}
      label={`${group.label} · ${group.count}`} onPress={() => toggle(group)} />
  </View>);

  if (!groups.length) return null;
  return <View style={{ gap: 5 }} accessibilityLabel={label}>
    <View style={{ flexDirection: "row", flexWrap: expanded ? "wrap" : "nowrap", alignItems: "center", gap: 6 }}>
      {all}
      {expanded ? <>{expand}{chips}</> : <>
        {visible.length > 0 && <ScrollView horizontal style={{ flexGrow: 0, flexShrink: 1, minWidth: 0 }}
          contentContainerStyle={{ alignItems: "center", gap: 6 }}>
          {chips}
        </ScrollView>}
        {hiddenCount > 0 && expand}
      </>}
    </View>
    {saveFailed && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusWarning }}>
      {t("필터 열림 상태를 이 기기에 저장하지 못했습니다.", "Could not save the filter view on this device.")}
    </Text>}
  </View>;
}
