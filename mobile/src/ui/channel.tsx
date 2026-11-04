import { View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { channelLabel } from "../lib/home-lines";
import { T } from "./components";
import { color } from "./theme";

/** A small mark for where a post goes (simple shapes in each platform's colour, not their logos). */
export function ChannelMark({ channel, size = 18 }: { channel: string; size?: number }) {
  if (channel === "instagram")
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
        <Defs>
          <LinearGradient id="ig" x1="0" y1="1" x2="1" y2="0">
            <Stop offset="0" stopColor="#feda75" />
            <Stop offset="0.35" stopColor="#fa7e1e" />
            <Stop offset="0.65" stopColor="#d62976" />
            <Stop offset="1" stopColor="#4f5bd5" />
          </LinearGradient>
        </Defs>
        <Rect x="1" y="1" width="22" height="22" rx="6.5" fill="url(#ig)" />
        <Rect x="6" y="6" width="12" height="12" rx="4" fill="none" stroke="#fff" strokeWidth="2" />
        <Circle cx="12" cy="12" r="2.8" fill="none" stroke="#fff" strokeWidth="2" />
      </Svg>
    );
  if (channel === "youtube")
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
        <Rect x="1" y="4" width="22" height="16" rx="5" fill="#ff0033" />
        <Path d="M10 8.5v7l6-3.5z" fill="#fff" />
      </Svg>
    );
  if (channel === "tiktok")
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
        <Rect x="1" y="1" width="22" height="22" rx="6.5" fill="#111" />
        <Path d="M13.5 6v8.2a2.7 2.7 0 1 1-2.2-2.65" fill="none" stroke="#25f4ee" strokeWidth="1.6" strokeLinecap="round" />
        <Path d="M13.5 6c.4 1.8 1.6 2.9 3.4 3.1" fill="none" stroke="#fe2c55" strokeWidth="1.6" strokeLinecap="round" />
      </Svg>
    );
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: color.mist2, alignItems: "center", justifyContent: "center" }}>
      <T v="caption" style={{ color: color.ink2, fontWeight: "700", fontSize: size * 0.55, lineHeight: size * 0.7 }}>
        {channelLabel(channel).charAt(0)}
      </T>
    </View>
  );
}

export function ChannelName({ channel, size = 18 }: { channel: string; size?: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <ChannelMark channel={channel} size={size} />
      <T v="bodySm">{channelLabel(channel)}</T>
    </View>
  );
}
