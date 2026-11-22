import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Pressable, Text } from "react-native";

export type Theme = PluginScreenProps["theme"];
export function Button({ label, accessibilityLabel, onPress, theme, selected = false, disabled = false }: {
  label: string; accessibilityLabel?: string; onPress: () => void; theme: Theme; selected?: boolean; disabled?: boolean;
}) {
  const c = theme.colors;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({ borderRadius: 7, paddingHorizontal: 10, paddingVertical: 7, opacity: disabled || pressed ? 0.6 : 1,
        borderWidth: 1, borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.accent : c.surface0 })}>
      <Text style={{ fontSize: 13, fontWeight: "500", color: selected ? c.accentForeground : c.foreground }}>{label}</Text>
    </Pressable>
  );
}
