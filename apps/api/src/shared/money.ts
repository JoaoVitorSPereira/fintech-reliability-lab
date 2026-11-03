// Money is BIGINT minor units in the database and in TypeScript (`bigint`),
// and a decimal STRING on the wire. GraphQL Int is 32-bit (R$21M in
// centavos) and JSON numbers lose precision past 2^53, so neither is safe.

export const CURRENCY_EXPONENT = { BRL: 2, USD: 2 } as const;
export type Currency = keyof typeof CURRENCY_EXPONENT;

export function isCurrency(value: string): value is Currency {
  return Object.hasOwn(CURRENCY_EXPONENT, value);
}

export function formatMinor(minor: bigint, currency: Currency): string {
  const exponent: number = CURRENCY_EXPONENT[currency];
  const sign = minor < 0n ? '-' : '';
  const digits = (minor < 0n ? -minor : minor)
    .toString()
    .padStart(exponent + 1, '0');
  if (exponent === 0) return sign + digits;
  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

// Strict: "10", "10.5", "10.50". No signs, exponents, separators or excess
// precision ("10.505" is rejected, not rounded: silently rounding someone's
// money is a bug). Returns null for anything else, including zero.
export function parsePositiveAmount(
  input: string,
  currency: Currency,
): bigint | null {
  const exponent: number = CURRENCY_EXPONENT[currency];
  const match = /^(0|[1-9]\d{0,14})(?:\.(\d+))?$/.exec(input);
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) return null;
  const minor = BigInt(match[1]! + fraction.padEnd(exponent, '0'));
  return minor > 0n ? minor : null;
}
