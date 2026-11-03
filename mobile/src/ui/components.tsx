import type { LucideIcon } from "lucide-react-native";
import { forwardRef, type ComponentRef, type ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { useAccent } from "./accent";
import { color, radius, shadow, space, type as typeScale } from "./theme";

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function T({ v = "body", style, ...rest }: TextProps & { v?: keyof typeof typeScale; style?: StyleProp<TextStyle> }) {
  return <Text {...rest} style={[typeScale[v], style]} />;
}

// ---------------------------------------------------------------------------
// Logo: rounded square in the accent gradient (graphite by default), white four-point sparkle
// ---------------------------------------------------------------------------

export function Logo({ size = 40 }: { size?: number }) {
  const ac = useAccent();
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessibilityLabel="MuseLaunch">
      <Defs>
        <LinearGradient id="mlg" x1="0" y1="0" x2="1" y2="1.2">
          <Stop offset="0" stopColor={ac.gradient[0]} />
          <Stop offset="0.52" stopColor={ac.gradient[1]} />
          <Stop offset="1" stopColor={ac.gradient[2]} />
        </LinearGradient>
      </Defs>
      <Rect width="32" height="32" rx="9" fill="url(#mlg)" />
      <Path d="M16 6C17.2 12 20 14.8 26 16 20 17.2 17.2 20 16 26 14.8 20 12 17.2 6 16 12 14.8 14.8 12 16 6Z" fill="#fff" />
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Buttons and chips
// ---------------------------------------------------------------------------

export type ButtonVariant = "primary" | "outline" | "ghost" | "soft" | "danger";

export function Button({
  title,
  onPress,
  variant = "primary",
  size = "lg",
  icon: Icon,
  trailing,
  loading,
  disabled,
  style,
  accessibilityLabel,
  ...rest
}: Omit<PressableProps, "style" | "children"> & {
  title: string;
  variant?: ButtonVariant;
  size?: "lg" | "md" | "sm";
  icon?: LucideIcon;
  trailing?: ReactNode;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const ac = useAccent();
  const off = Boolean(disabled || loading);
  const fg = variant === "primary" || variant === "danger" ? color.white : variant === "soft" ? ac.accentInk : variant === "ghost" ? color.ink2 : color.ink;
  const h = size === "lg" ? 52 : size === "md" ? 44 : 36;
  return (
    <Pressable
      {...rest}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: off, busy: Boolean(loading) }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { minHeight: h, paddingHorizontal: size === "sm" ? 14 : 20 },
        variant === "primary" && { backgroundColor: pressed ? ac.accentHover : ac.accent },
        variant === "danger" && { backgroundColor: color.danger },
        variant === "outline" && { backgroundColor: pressed ? color.mist : color.surface, borderWidth: 1, borderColor: color.lineStrong },
        variant === "soft" && { backgroundColor: pressed ? color.mist2 : ac.accentSoft },
        variant === "ghost" && { backgroundColor: pressed ? color.mist : "transparent" },
        off && !loading && { opacity: 0.45 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : Icon ? <Icon size={18} color={fg} strokeWidth={2} /> : null}
      <Text style={[styles.buttonText, { color: fg, fontSize: size === "sm" ? 14 : 16 }]} numberOfLines={1}>
        {title}
      </Text>
      {trailing}
    </Pressable>
  );
}

export function IconButton({ icon: Icon, label, onPress, tint = color.ink2, size = 22, style }: { icon: LucideIcon; label: string; onPress: () => void; tint?: string; size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8} style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: color.mist }, style]}>
      <Icon size={size} color={tint} strokeWidth={1.9} />
    </Pressable>
  );
}

export function Chip({ label, selected, onPress, icon: Icon, disabled }: { label: string; selected?: boolean; onPress: () => void; icon?: LucideIcon; disabled?: boolean }) {
  const ac = useAccent();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected), disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected ? { backgroundColor: ac.accentSoft, borderColor: ac.accent } : pressed ? { backgroundColor: color.mist } : null, disabled && { opacity: 0.45 }]}
    >
      {Icon ? <Icon size={15} color={selected ? ac.accentInk : color.ink2} strokeWidth={2} /> : null}
      <Text style={[typeScale.footnote, { color: selected ? ac.accentInk : color.ink, fontWeight: selected ? "600" : "500" }]}>{label}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  return <View style={[styles.card, padded && { padding: space.lg }, style]}>{children}</View>;
}

export function Notice({ children, tone = "neutral", icon: Icon, style }: { children: ReactNode; tone?: "neutral" | "warning" | "success" | "accent" | "danger"; icon?: LucideIcon; style?: StyleProp<ViewStyle> }) {
  const ac = useAccent();
  const bg = tone === "warning" ? color.warningSoft : tone === "success" ? color.successSoft : tone === "accent" ? ac.accentSoft : tone === "danger" ? color.dangerSoft : color.mist;
  const fg = tone === "warning" ? color.warning : tone === "success" ? color.success : tone === "accent" ? ac.accentInk : tone === "danger" ? color.danger : color.ink2;
  return (
    <View style={[styles.notice, { backgroundColor: bg }, style]}>
      {Icon ? <Icon size={16} color={fg} strokeWidth={2} style={{ marginTop: 2 }} /> : null}
      <View style={{ flex: 1, gap: 4 }}>{typeof children === "string" ? <T v="footnote" style={{ color: tone === "neutral" ? color.ink2 : fg }}>{children}</T> : children}</View>
    </View>
  );
}

export function ProgressBar({ value, style }: { value: number | null; style?: StyleProp<ViewStyle> }) {
  const ac = useAccent();
  const pct = value === null ? 30 : Math.max(2, Math.min(100, value));
  return (
    <View style={[styles.track, style]} accessibilityRole="progressbar" accessibilityValue={value === null ? undefined : { min: 0, max: 100, now: Math.round(value) }}>
      <View style={[styles.fill, { width: `${pct}%`, backgroundColor: ac.accent }, value === null && { opacity: 0.5 }]} />
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: color.line }, style]} />;
}

export function Spinner({ tint }: { tint?: string }) {
  const ac = useAccent();
  return <ActivityIndicator size="small" color={tint ?? ac.accent} />;
}

export function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.sectionTitle}>
      <T v="title3">{title}</T>
      {action}
    </View>
  );
}

export function LinkText({ title, onPress, style }: { title: string; onPress: () => void; style?: StyleProp<TextStyle> }) {
  const ac = useAccent();
  return (
    <Pressable accessibilityRole="link" onPress={onPress} hitSlop={10}>
      {({ pressed }) => <Text style={[typeScale.bodySm, { color: ac.accent, fontWeight: "600", opacity: pressed ? 0.6 : 1 }, style]}>{title}</Text>}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const Field = forwardRef<ComponentRef<typeof TextInput>, TextInputProps & { invalid?: boolean }>(function Field({ style, invalid, multiline, ...rest }, ref) {
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={color.ink3}
      multiline={multiline}
      {...rest}
      style={[typeScale.body, styles.field, multiline && { minHeight: 96, textAlignVertical: "top", paddingTop: 12 }, invalid && { borderColor: color.danger }, style]}
    />
  );
});

// ---------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------

export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View style={styles.sheetRoot}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.grabber} />
            <View style={styles.sheetHeader}>
              <T v="title3" style={{ flex: 1 }} accessibilityRole="header">
                {title}
              </T>
              <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12} style={styles.sheetClose}>
                <Text style={{ fontSize: 15, color: color.ink2, fontWeight: "600" }}>Close</Text>
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.lg, gap: space.lg }} style={{ flexGrow: 0 }}>
              {children}
            </ScrollView>
            {footer ? <View style={{ paddingHorizontal: space.gutter, paddingTop: space.sm }}>{footer}</View> : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  button: { borderRadius: radius.full, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  buttonText: { fontWeight: "600" },
  iconButton: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 38, paddingHorizontal: 14, borderRadius: radius.full, borderWidth: 1, borderColor: color.line, backgroundColor: color.surface },
  card: { backgroundColor: color.surface, borderRadius: 22, ...shadow.raised },
  notice: { flexDirection: "row", gap: 10, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12 },
  track: { height: 4, borderRadius: 2, backgroundColor: color.mist2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
  sectionTitle: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 12 },
  field: { borderWidth: 1, borderColor: color.lineStrong, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, minHeight: 48, backgroundColor: color.surface },
  sheetRoot: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.32)" },
  sheet: { backgroundColor: color.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: "92%", ...shadow.float },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: color.mist2, marginTop: 8 },
  sheetHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.gutter, paddingTop: 10, paddingBottom: 12 },
  sheetClose: { paddingVertical: 6, paddingHorizontal: 4 },
});
