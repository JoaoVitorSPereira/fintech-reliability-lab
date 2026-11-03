import { type ReactNode } from 'react';
import { ActivityIndicator, type PressableProps, type TextInputProps } from 'react-native';
import styled, { useTheme } from 'styled-components/native';
import { isNegative } from '@/lib/money';

export const Screen = styled.ScrollView.attrs(({ theme }) => ({
  contentInsetAdjustmentBehavior: 'automatic',
  contentContainerStyle: { padding: theme.spacing.lg, gap: theme.spacing.lg, paddingBottom: theme.spacing.xxl * 2 },
}))`
  flex: 1;
  background-color: ${({ theme }) => theme.colors.background};
`;

export const Card = styled.View`
  background-color: ${({ theme }) => theme.colors.surface};
  border-radius: ${({ theme }) => theme.radius.lg}px;
  padding: ${({ theme }) => theme.spacing.lg}px;
  gap: ${({ theme }) => theme.spacing.md}px;
  border-width: 1px;
  border-color: ${({ theme }) => theme.colors.border};
`;

export const Row = styled.View<{ gap?: number }>`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: ${({ gap, theme }) => gap ?? theme.spacing.sm}px;
`;

export const Body = styled.Text<{ secondary?: boolean; bold?: boolean }>`
  font-size: ${({ theme }) => theme.font.body}px;
  color: ${({ secondary, theme }) => (secondary ? theme.colors.textSecondary : theme.colors.text)};
  font-weight: ${({ bold }) => (bold ? '600' : '400')};
  font-variant: tabular-nums;
`;

export const Caption = styled.Text`
  font-size: ${({ theme }) => theme.font.caption}px;
  color: ${({ theme }) => theme.colors.textSecondary};
`;

export const SectionTitle = styled.Text`
  font-size: ${({ theme }) => theme.font.title}px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

export const Display = styled.Text`
  font-size: ${({ theme }) => theme.font.display}px;
  font-weight: 700;
  color: ${({ theme }) => theme.colors.text};
  font-variant: tabular-nums;
`;

/** Green for gains, red for losses. Never the only signal: values carry a sign too. */
export const Delta = styled.Text<{ value: string | null | undefined; size?: number }>`
  font-size: ${({ size, theme }) => size ?? theme.font.body}px;
  font-weight: 600;
  font-variant: tabular-nums;
  color: ${({ value, theme }) =>
    value == null ? theme.colors.textSecondary : isNegative(value) ? theme.colors.negative : theme.colors.positive};
`;

const ButtonBase = styled.Pressable<{ variant: 'primary' | 'secondary' | 'danger'; disabled?: boolean | null }>`
  min-height: 48px;
  border-radius: ${({ theme }) => theme.radius.md}px;
  align-items: center;
  justify-content: center;
  padding: 0 ${({ theme }) => theme.spacing.lg}px;
  opacity: ${({ disabled }) => (disabled ? 0.5 : 1)};
  background-color: ${({ variant, theme }) =>
    variant === 'primary' ? theme.colors.accent : variant === 'danger' ? theme.colors.negative : theme.colors.surfaceAlt};
`;

const ButtonLabel = styled.Text<{ variant: 'primary' | 'secondary' | 'danger' }>`
  font-size: ${({ theme }) => theme.font.body}px;
  font-weight: 600;
  color: ${({ variant, theme }) => (variant === 'secondary' ? theme.colors.text : theme.colors.accentText)};
`;

export function Button({
  title,
  variant = 'primary',
  loading,
  ...props
}: PressableProps & { title: string; variant?: 'primary' | 'secondary' | 'danger'; loading?: boolean }) {
  const theme = useTheme();
  return (
    <ButtonBase variant={variant} accessibilityRole="button" accessibilityState={{ busy: !!loading, disabled: !!props.disabled }} {...props} disabled={props.disabled || loading}>
      {loading ? <ActivityIndicator color={variant === 'secondary' ? theme.colors.text : theme.colors.accentText} /> : <ButtonLabel variant={variant}>{title}</ButtonLabel>}
    </ButtonBase>
  );
}

const Input = styled.TextInput.attrs(({ theme }) => ({ placeholderTextColor: theme.colors.textSecondary }))`
  min-height: 48px;
  border-radius: ${({ theme }) => theme.radius.md}px;
  padding: 0 ${({ theme }) => theme.spacing.md}px;
  background-color: ${({ theme }) => theme.colors.surfaceAlt};
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.font.body}px;
`;

const ErrorText = styled.Text`
  color: ${({ theme }) => theme.colors.negative};
  font-size: ${({ theme }) => theme.font.caption}px;
`;

const FieldBox = styled.View`
  gap: ${({ theme }) => theme.spacing.xs}px;
`;

export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  return (
    <FieldBox>
      <Caption>{label}</Caption>
      <Input accessibilityLabel={label} {...props} />
      {error ? <ErrorText accessibilityRole="alert">{error}</ErrorText> : null}
    </FieldBox>
  );
}

export const Banner = styled.View<{ tone?: 'warning' | 'info' }>`
  border-radius: ${({ theme }) => theme.radius.md}px;
  padding: ${({ theme }) => theme.spacing.md}px;
  background-color: ${({ tone, theme }) => (tone === 'info' ? theme.colors.surfaceAlt : theme.colors.warningSurface)};
`;

export const BannerText = styled.Text`
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.font.caption}px;
`;

const Centered = styled.View`
  flex: 1;
  justify-content: center;
  min-height: 160px;
  padding: ${({ theme }) => theme.spacing.xl}px;
  align-items: center;
  gap: ${({ theme }) => theme.spacing.md}px;
`;

export function Loading() {
  const theme = useTheme();
  return (
    <Centered>
      <ActivityIndicator color={theme.colors.textSecondary} />
    </Centered>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Centered>
      <Body secondary>{title}</Body>
      {children}
    </Centered>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Centered>
      <Body secondary>{message}</Body>
      {onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} /> : null}
    </Centered>
  );
}

const SegmentWrap = styled.View`
  flex-direction: row;
  background-color: ${({ theme }) => theme.colors.surfaceAlt};
  border-radius: ${({ theme }) => theme.radius.sm}px;
  padding: 2px;
`;

const Segment = styled.Pressable<{ active: boolean }>`
  flex: 1;
  min-height: 32px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background-color: ${({ active, theme }) => (active ? theme.colors.surface : 'transparent')};
`;

const SegmentLabel = styled.Text<{ active: boolean }>`
  font-size: ${({ theme }) => theme.font.caption}px;
  font-weight: ${({ active }) => (active ? '600' : '400')};
  color: ${({ active, theme }) => (active ? theme.colors.text : theme.colors.textSecondary)};
`;

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  labels?: Partial<Record<T, string>>;
}) {
  return (
    <SegmentWrap accessibilityRole="tablist">
      {options.map((option) => (
        <Segment key={option} active={option === value} onPress={() => onChange(option)} accessibilityRole="tab" accessibilityState={{ selected: option === value }}>
          <SegmentLabel active={option === value}>{labels?.[option] ?? option}</SegmentLabel>
        </Segment>
      ))}
    </SegmentWrap>
  );
}
