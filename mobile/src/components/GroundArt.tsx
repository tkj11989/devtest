import { useId } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, Line, LinearGradient, Polygon, RadialGradient, Rect, Stop } from 'react-native-svg';

// Illustrated stand-in for venue photos: a floodlit ground drawn for the
// sport, varied per ground so cards don't all look alike. Swap for real
// photos (expo-image) once venues upload them.

const SKIES = [
  ['#06121F', '#123A4A'],
  ['#0B1027', '#2B2F5C'],
  ['#0A1A14', '#1E4A3A'],
  ['#140F24', '#3B2A55'],
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

type Props = { seed: string; sportId: string; indoor?: boolean; variant?: number; style?: StyleProp<ViewStyle> };

export function GroundArt({ seed, sportId, indoor, variant = 0, style }: Props) {
  const uid = useId().replace(/:/g, '');
  const n = hash(seed) + variant;
  const [skyTop, skyBottom] = SKIES[n % SKIES.length];
  const horizon = 112 + (n % 3) * 8;
  const spread = 40 + (variant % 3) * 25; // perspective of the field

  const field = `${-spread},240 ${400 + spread},240 ${330 - (n % 20)},${horizon} ${70 + (n % 20)},${horizon}`;
  const stripes = Array.from({ length: 7 }, (_, i) => {
    const t0 = i / 7;
    const t1 = (i + 1) / 7;
    const y0 = horizon + (240 - horizon) * t0 ** 1.4;
    const y1 = horizon + (240 - horizon) * t1 ** 1.4;
    return { y0, y1, i };
  });

  return (
    <View style={[{ overflow: 'hidden', backgroundColor: skyTop }, style]}>
      <Svg width="100%" height="100%" viewBox="0 0 400 240" preserveAspectRatio="xMidYMid slice">
        <Defs>
          <LinearGradient id={`sky${uid}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={indoor ? '#2A2F36' : skyTop} />
            <Stop offset="1" stopColor={indoor ? '#4A525C' : skyBottom} />
          </LinearGradient>
          <LinearGradient id={`grass${uid}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={indoor && sportId !== 'cricket' ? '#B9783F' : '#2E8B3E'} />
            <Stop offset="1" stopColor={indoor && sportId !== 'cricket' ? '#8E5527' : '#1F6B2C'} />
          </LinearGradient>
          <RadialGradient id={`glow${uid}`} cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#FFFBE6" stopOpacity="1" />
            <Stop offset="0.35" stopColor="#FFF2B0" stopOpacity="0.55" />
            <Stop offset="1" stopColor="#FFF2B0" stopOpacity="0" />
          </RadialGradient>
        </Defs>

        <Rect x="0" y="0" width="400" height="240" fill={`url(#sky${uid})`} />

        {indoor ? (
          // Roof trusses and hanging lights
          <G>
            {[60, 140, 220, 300, 380].map((x) => (
              <Line key={x} x1={x} y1="0" x2={200 + (x - 200) * 0.6} y2={horizon - 10} stroke="#5D6670" strokeWidth="2" />
            ))}
            {[90, 170, 250, 330].map((x) => (
              <G key={x}>
                <Circle cx={x} cy={40} r={30} fill={`url(#glow${uid})`} />
                <Rect x={x - 12} y={36} width="24" height="5" rx="2" fill="#FFFDF0" />
              </G>
            ))}
          </G>
        ) : (
          <G>
            {/* stars */}
            {Array.from({ length: 14 }, (_, i) => (
              <Circle key={i} cx={(n * (i + 3) * 37) % 400} cy={(n * (i + 7) * 13) % (horizon - 50)} r={0.9} fill="#fff" opacity={0.5} />
            ))}
            {/* stands */}
            <Polygon points={`0,${horizon + 6} 0,${horizon - 22} 400,${horizon - 22} 400,${horizon + 6}`} fill="#0D1B22" opacity={0.85} />
            {Array.from({ length: 40 }, (_, i) => (
              <Rect key={i} x={i * 10 + 2} y={horizon - 18 + (i % 3) * 5} width="5" height="3" fill="#2E4A57" opacity={0.7} />
            ))}
            {/* floodlight towers */}
            {[30, 370, ...(variant % 2 ? [] : [140, 260])].map((x, i) => {
              const top = i < 2 ? 34 : 60;
              return (
                <G key={x}>
                  <Line x1={x} y1={top + 10} x2={x} y2={horizon - 18} stroke="#26343C" strokeWidth={i < 2 ? 4 : 3} />
                  <Circle cx={x} cy={top} r={i < 2 ? 46 : 32} fill={`url(#glow${uid})`} />
                  <Rect x={x - 13} y={top - 7} width="26" height="14" rx="2" fill="#FFFDF0" />
                </G>
              );
            })}
          </G>
        )}

        {/* field with mowing stripes */}
        <Polygon points={field} fill={`url(#grass${uid})`} />
        {!indoor &&
          stripes
            .filter((s) => s.i % 2 === 0)
            .map((s) => <Rect key={s.i} x="-100" y={s.y0} width="600" height={s.y1 - s.y0} fill="#ffffff" opacity={0.05} />)}

        <SportMarkings sportId={sportId} horizon={horizon} />
      </Svg>
    </View>
  );
}

function SportMarkings({ sportId, horizon }: { sportId: string; horizon: number }) {
  const mid = (horizon + 240) / 2 + 8;
  switch (sportId) {
    case 'cricket':
      return (
        <G>
          <Polygon points={`186,${horizon + 14} 214,${horizon + 14} 226,236 174,236`} fill="#C9A86A" opacity={0.95} />
          <Line x1="180" y1={horizon + 40} x2="220" y2={horizon + 40} stroke="#fff" strokeWidth="1.5" />
          <Line x1="176" y1="214" x2="224" y2="214" stroke="#fff" strokeWidth="2" />
          {[195, 200, 205].map((x) => (
            <Line key={x} x1={x} y1={horizon + 22} x2={x} y2={horizon + 34} stroke="#F5F0E1" strokeWidth="1.5" />
          ))}
          <Ellipse cx="200" cy={mid + 30} rx="170" ry="60" fill="none" stroke="#ffffff" strokeOpacity={0.35} strokeWidth="1.5" />
        </G>
      );
    case 'football':
      return (
        <G stroke="#fff" strokeOpacity={0.85} strokeWidth="2" fill="none">
          <Polygon points={`60,236 340,236 300,${horizon + 6} 100,${horizon + 6}`} />
          <Line x1="80" y1={mid} x2="320" y2={mid} />
          <Ellipse cx="200" cy={mid} rx="40" ry="14" />
          <Polygon points={`170,${horizon + 6} 230,${horizon + 6} 230,${horizon - 8} 170,${horizon - 8}`} strokeWidth="2.5" />
        </G>
      );
    case 'basketball':
      return (
        <G>
          <Polygon points={`60,236 340,236 300,${horizon + 6} 100,${horizon + 6}`} fill="#C1572F" />
          <G stroke="#fff" strokeWidth="2" fill="none">
            <Line x1="80" y1={mid} x2="320" y2={mid} />
            <Ellipse cx="200" cy={mid} rx="34" ry="12" />
            <Rect x="186" y={horizon - 26} width="28" height="18" />
          </G>
          <Circle cx="200" cy={horizon - 4} r="5" fill="none" stroke="#FF7A2F" strokeWidth="2" />
        </G>
      );
    default: // badminton / tennis
      return (
        <G>
          <Polygon points={`70,236 330,236 290,${horizon + 6} 110,${horizon + 6}`} fill={sportId === 'tennis' ? '#2F6FB0' : '#2E7D4F'} />
          <G stroke="#fff" strokeWidth="2" fill="none">
            <Polygon points={`70,236 330,236 290,${horizon + 6} 110,${horizon + 6}`} />
            <Line x1="200" y1="236" x2="200" y2={horizon + 6} />
            <Line x1="92" y1={mid + 30} x2="308" y2={mid + 30} />
          </G>
          <Rect x="88" y={mid - 14} width="224" height="12" fill="none" stroke="#EEE" strokeWidth="1" strokeDasharray="3,2" />
          <Line x1="88" y1={mid - 14} x2="312" y2={mid - 14} stroke="#fff" strokeWidth="2" />
        </G>
      );
  }
}
