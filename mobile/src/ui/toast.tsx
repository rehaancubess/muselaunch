import { CircleCheck, TriangleAlert } from "lucide-react-native";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "./components";
import { color, shadow } from "./theme";

type Toast = { title: string; body?: string; tone: "success" | "error" };
type Show = (t: { title: string; body?: string; tone?: Toast["tone"] }) => void;

const ToastContext = createContext<Show>(() => {});
export const useToast = () => useContext(ToastContext);

/** One short message at the top ("Post scheduled", "Couldn’t record that"), gone after a few seconds. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback<Show>((t) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ title: t.title, body: t.body, tone: t.tone ?? "success" });
    timer.current = setTimeout(() => setToast(null), t.tone === "error" ? 6000 : 3800);
  }, []);
  const Icon = toast?.tone === "error" ? TriangleAlert : CircleCheck;
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast ? (
        <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 8 }]}>
          <Pressable onPress={() => setToast(null)} accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.toast}>
            <Icon size={18} color={toast.tone === "error" ? color.danger : color.success} strokeWidth={2.2} style={{ marginTop: 1 }} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="bodySm" style={{ fontWeight: "600" }}>
                {toast.title}
              </T>
              {toast.body ? <T v="footnote">{toast.body}</T> : null}
            </View>
          </Pressable>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 12, right: 12, alignItems: "center", zIndex: 1000 },
  toast: { flexDirection: "row", gap: 10, width: "100%", maxWidth: 520, backgroundColor: color.surface, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12, ...shadow.float },
});
