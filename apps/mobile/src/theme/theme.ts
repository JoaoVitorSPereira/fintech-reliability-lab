// One source of truth for colors, spacing and type. Components read tokens
// through styled-components' ThemeProvider; no hex values in screens.

const palette = {
  light: {
    background: '#F5F6F8',
    surface: '#FFFFFF',
    surfaceAlt: '#EEF0F3',
    border: '#E1E4E8',
    text: '#0B0D12',
    textSecondary: '#5F6673',
    accent: '#2563EB',
    accentText: '#FFFFFF',
    positive: '#15803D',
    negative: '#DC2626',
    warning: '#B45309',
    warningSurface: '#FEF3C7',
    chartLine: '#2563EB',
  },
  dark: {
    background: '#0B0D12',
    surface: '#151821',
    surfaceAlt: '#1D212C',
    border: '#272C38',
    text: '#F3F4F6',
    textSecondary: '#9AA1AE',
    accent: '#3B82F6',
    accentText: '#FFFFFF',
    positive: '#22C55E',
    negative: '#F87171',
    warning: '#FBBF24',
    warningSurface: '#3A2E0B',
    chartLine: '#60A5FA',
  },
} as const;

const shared = {
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 8, md: 12, lg: 16, pill: 999 },
  font: { caption: 12, body: 15, title: 17, heading: 22, display: 34 },
} as const;

export type AppTheme = typeof shared & { colors: Record<keyof typeof palette.light, string>; dark: boolean };

export function makeTheme(scheme: 'light' | 'dark'): AppTheme {
  return { ...shared, colors: palette[scheme], dark: scheme === 'dark' };
}
