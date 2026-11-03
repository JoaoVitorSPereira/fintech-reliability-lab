import { memo, useMemo } from 'react';
import { View } from 'react-native';
import { Area, Bar, CartesianChart, Candlestick, Line } from 'victory-native';
import { useTheme } from 'styled-components/native';

// Charts draw pixels, so here (and only here) decimal strings become numbers.
// Nothing computed from these numbers flows back into money values.
const toNumber = (value: string) => Number(value);

// Sparklines are pure shape: no grid. Larger charts keep a faint grid only.
const NO_GRID = { yAxis: [{ lineWidth: 0, tickCount: 0 }], xAxis: { lineWidth: 0, tickCount: 0 } } as const;

export type CandlePoint = { openTime: string; open: string; high: string; low: string; close: string; volume: string };

/** Tiny 24h line for list rows. Memoized: list rows re-render on every price tick. */
export const Sparkline = memo(function Sparkline({ values, width = 72, height = 28 }: { values: readonly string[]; width?: number; height?: number }) {
  const theme = useTheme();
  const data = useMemo(() => values.map((value, index) => ({ x: index, y: toNumber(value) })), [values]);
  if (data.length < 2) return <View style={{ width, height }} />;
  const rising = data[data.length - 1]!.y >= data[0]!.y;
  return (
    <View style={{ width, height }} accessibilityLabel={rising ? '24 hour trend up' : '24 hour trend down'}>
      <CartesianChart data={data} xKey="x" yKeys={['y']} yAxis={[...NO_GRID.yAxis]} xAxis={NO_GRID.xAxis}>
        {({ points }) => <Line points={points.y} color={rising ? theme.colors.positive : theme.colors.negative} strokeWidth={1.5} />}
      </CartesianChart>
    </View>
  );
});

// ponytail: downsample by striding. Good enough for display; LTTB keeps
// spikes better if charts ever need to preserve extremes exactly.
function downsample<T>(rows: readonly T[], max: number): T[] {
  if (rows.length <= max) return [...rows];
  const step = rows.length / max;
  return Array.from({ length: max }, (_, i) => rows[Math.floor(i * step)]!);
}

export function PriceChart({ candles, mode, height = 240 }: { candles: readonly CandlePoint[]; mode: 'line' | 'candles'; height?: number }) {
  const theme = useTheme();
  const data = useMemo(
    () =>
      downsample(candles, mode === 'candles' ? 120 : 400).map((candle) => ({
        t: Date.parse(candle.openTime),
        open: toNumber(candle.open),
        high: toNumber(candle.high),
        low: toNumber(candle.low),
        close: toNumber(candle.close),
      })),
    [candles, mode],
  );
  if (data.length < 2) return null;
  return (
    <View style={{ height }} accessibilityLabel="Price chart">
      <CartesianChart data={data} xKey="t" yKeys={['open', 'high', 'low', 'close']} domainPadding={{ top: 12, bottom: 12, left: 6, right: 6 }}>
        {({ points, chartBounds }) =>
          mode === 'candles' ? (
            <Candlestick
              openPoints={points.open}
              highPoints={points.high}
              lowPoints={points.low}
              closePoints={points.close}
              chartBounds={chartBounds}
              candleColors={{ positive: theme.colors.positive, negative: theme.colors.negative, neutral: theme.colors.textSecondary }}
            />
          ) : (
            <>
              <Area points={points.close} y0={chartBounds.bottom} color={theme.colors.chartLine} opacity={0.12} />
              <Line points={points.close} color={theme.colors.chartLine} strokeWidth={2} />
            </>
          )
        }
      </CartesianChart>
    </View>
  );
}

export function VolumeChart({ candles, height = 60 }: { candles: readonly CandlePoint[]; height?: number }) {
  const theme = useTheme();
  const data = useMemo(
    () => downsample(candles, 120).map((candle) => ({ t: Date.parse(candle.openTime), volume: toNumber(candle.volume) })),
    [candles],
  );
  if (data.length < 2) return null;
  return (
    <View style={{ height }} accessibilityLabel="Trading volume">
      <CartesianChart data={data} xKey="t" yKeys={['volume']} domainPadding={{ left: 6, right: 6 }}>
        {({ points, chartBounds }) => (
          <Bar points={points.volume} chartBounds={chartBounds} color={theme.colors.textSecondary} opacity={0.4} innerPadding={0.2} />
        )}
      </CartesianChart>
    </View>
  );
}

export function ValueChart({ points, height = 160 }: { points: readonly { at: string; value: string }[]; height?: number }) {
  const theme = useTheme();
  const data = useMemo(() => points.map((point) => ({ t: Date.parse(point.at), value: toNumber(point.value) })), [points]);
  if (data.length < 2) return null;
  return (
    <View style={{ height }} accessibilityLabel="Portfolio value over time">
      <CartesianChart data={data} xKey="t" yKeys={['value']} domainPadding={{ top: 8, bottom: 8 }}>
        {({ points: p, chartBounds }) => (
          <>
            <Area points={p.value} y0={chartBounds.bottom} color={theme.colors.chartLine} opacity={0.12} />
            <Line points={p.value} color={theme.colors.chartLine} strokeWidth={2} />
          </>
        )}
      </CartesianChart>
    </View>
  );
}

/** Stacked horizontal bar of allocation percentages (cash + positions). */
export function AllocationBar({ slices }: { slices: { label: string; pct: number }[] }) {
  const theme = useTheme();
  const colors = [theme.colors.accent, theme.colors.positive, theme.colors.warning, theme.colors.negative, theme.colors.textSecondary];
  return (
    <View style={{ flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden', backgroundColor: theme.colors.surfaceAlt }} accessibilityLabel="Asset allocation">
      {slices.map((slice, index) => (
        <View key={slice.label} style={{ width: `${slice.pct}%`, backgroundColor: colors[index % colors.length] }} />
      ))}
    </View>
  );
}
