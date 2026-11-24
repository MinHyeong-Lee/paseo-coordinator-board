import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View, type ViewProps } from "react-native";

export type Theme = PluginScreenProps["theme"];
const buttonFrame = { borderRadius: 7, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1 };
const buttonText = { fontSize: 13, fontWeight: "500" as const };

export function ButtonLabelMeasure({ label, onLayout }: { label: string; onLayout: ViewProps["onLayout"] }) {
  return <View onLayout={onLayout} style={buttonFrame}>
    <Text numberOfLines={1} style={buttonText}>{label}</Text>
  </View>;
}

export function Button({ label, accessibilityLabel, describedBy, onPress, theme, selected = false, disabled = false, toggle = false, expanded, singleLine, onLayout }: {
  label: string; accessibilityLabel?: string; describedBy?: string; onPress: () => void; theme: Theme; selected?: boolean; disabled?: boolean; toggle?: boolean; expanded?: boolean; singleLine?: boolean; onLayout?: ViewProps["onLayout"];
}) {
  const c = theme.colors;
  return (
    <Pressable accessibilityRole={toggle ? "checkbox" : "button"} aria-checked={toggle ? selected : undefined} aria-expanded={expanded} aria-describedby={describedBy} accessibilityLabel={accessibilityLabel ?? label} accessibilityState={toggle ? { disabled, checked:selected } : { disabled, selected, expanded }} disabled={disabled} onPress={onPress} onLayout={onLayout}
      style={({ pressed }) => ({ ...buttonFrame, opacity: disabled || pressed ? 0.6 : 1, borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.accent : c.surface0 })}>
      <Text numberOfLines={singleLine ? 1 : undefined} style={{ ...buttonText, color: selected ? c.accentForeground : c.foreground }}>{label}</Text>
    </Pressable>
  );
}

export type SessionChipProps = { label: string; accessibilityLabel: string; onPress: () => void; theme: Theme };

export function SessionChip({ label, accessibilityLabel, onPress, theme }: SessionChipProps) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress}
    style={({ pressed }) => ({ alignSelf: "flex-start", maxWidth: "100%", minHeight: 26, justifyContent: "center",
      paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: c.border, borderRadius: 12,
      backgroundColor: pressed ? c.surface2 : c.surface0 })}>
    <Text style={{ color: c.foreground, fontSize: 12 }}>{label} ›</Text>
  </Pressable>;
}
