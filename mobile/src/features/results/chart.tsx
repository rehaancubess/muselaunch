import { useState } from "react";
import { Platform, View } from "react-native";
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop, Text as SvgText } from "react-native-svg";
import type { ResultsSeries } from "../../api/types";
import { chartModel, shortNumber } from "../../lib/results-lines";
import { color } from "../../ui/theme";
import { useAccent } from "../../ui/accent";

const HEIGHT = 168;
const PAD = { l: 8, r: 8, t: 14, b: 24 };
const FONT = Platform.select({ web: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif", default: undefined });

/** The main number per day: real daily numbers only; a day without one is a gap, never a 0. */
export function DailyChart({ series }: { series: ResultsSeries }) {
  const ac = useAccent();
  const [width, setWidth] = useState(0);
  const m = width ? chartModel(series.points, { width, height: HEIGHT, pad: PAD }) : null;
  const measured = series.points.filter((p) => p.value !== null);
  const peak = measured.length ? Math.max(...measured.map((p) => p.value!)) : 0;
  return (
    <View
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
      style={{ height: HEIGHT }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${series.label} per day: ${measured.length} days with a number, highest ${shortNumber(peak)}.`}
    >
      {m ? (
        <Svg width={width} height={HEIGHT}>
          <Defs>
            <LinearGradient id="area" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={ac.accent} stopOpacity={0.22} />
              <Stop offset="1" stopColor={ac.accent} stopOpacity={0.02} />
            </LinearGradient>
          </Defs>
          <Line x1={PAD.l} x2={width - PAD.r} y1={m.y(m.max)} y2={m.y(m.max)} stroke={color.line} strokeDasharray="3 4" />
          <Line x1={PAD.l} x2={width - PAD.r} y1={m.baseline} y2={m.baseline} stroke={color.lineStrong} />
          <SvgText x={width - PAD.r} y={m.y(m.max) - 4} fontSize={10} fontFamily={FONT} fill={color.ink3} textAnchor="end">
            {shortNumber(m.max)}
          </SvgText>
          {m.areas.map((d, i) => (
            <Path key={`a${i}`} d={d} fill="url(#area)" />
          ))}
          {m.lines.map((d, i) => (
            <Path key={`l${i}`} d={d} fill="none" stroke={ac.accent} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {m.dots.map((d) => (
            <Circle key={`d${d.i}`} cx={d.x} cy={d.y} r={3} fill={ac.accent} />
          ))}
          {m.ticks.map((t, i) => (
            <SvgText key={`t${t.i}`} x={t.x} y={HEIGHT - 6} fontSize={10} fontFamily={FONT} fill={color.ink3} textAnchor={i === 0 ? "start" : i === m.ticks.length - 1 ? "end" : "middle"}>
              {t.label}
            </SvgText>
          ))}
        </Svg>
      ) : null}
    </View>
  );
}
