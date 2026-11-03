// Display formatting for exact decimal strings from the API. We never turn
// money into a JS number: "92233720368547758.07" must print exactly.

const SYMBOLS: Record<string, string> = { BRL: 'R$', USD: '$' };

function group(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function split(amount: string): { negative: boolean; integer: string; fraction: string } {
  const negative = amount.startsWith('-');
  const [integer = '0', fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  return { negative, integer, fraction };
}

/** "1050.25", "BRL" -> "R$1,050.25"; unknown currency codes are suffixed. */
export function formatMoney(amount: string, currency: string, options: { signed?: boolean } = {}): string {
  const { negative, integer, fraction } = split(amount);
  const body = `${group(integer)}.${fraction.padEnd(2, '0').slice(0, Math.max(2, fraction.length))}`;
  const sign = negative ? '-' : options.signed && amount !== '0' && !/^0(\.0+)?$/.test(amount) ? '+' : '';
  const symbol = SYMBOLS[currency];
  return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${currency}`;
}

/** Market prices: 2 decimals above 1, up to 8 significant decimals below. */
export function formatPrice(price: string): string {
  const { negative, integer, fraction } = split(price);
  const sign = negative ? '-' : '';
  if (integer !== '0') return `${sign}${group(integer)}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  const trimmed = fraction.replace(/0+$/, '');
  const firstSignificant = trimmed.search(/[1-9]/);
  const decimals = firstSignificant < 0 ? 2 : Math.max(2, Math.min(firstSignificant + 4, 10));
  return `${sign}0.${fraction.padEnd(decimals, '0').slice(0, decimals)}`;
}

/** "-1.58492" -> "-1.58%" ; null -> "—" */
export function formatPercent(value: string | null | undefined): string {
  if (value == null) return '—';
  const { negative, integer, fraction } = split(value);
  const rounded = `${integer}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  return `${negative ? '-' : '+'}${rounded}%`;
}

export function isNegative(value: string | null | undefined): boolean {
  return !!value && value.startsWith('-');
}

/** Big numbers for market cap / volume: "1543999804108" -> "1.54T". Display only. */
export function formatCompact(value: string | null | undefined): string {
  if (!value) return '—';
  const integer = split(value).integer;
  const units: [number, string][] = [[12, 'T'], [9, 'B'], [6, 'M'], [3, 'K']];
  for (const [digits, unit] of units) {
    if (integer.length > digits) {
      const whole = integer.slice(0, integer.length - digits);
      const decimals = integer.slice(integer.length - digits, integer.length - digits + 2);
      return `${whole}.${decimals}${unit}`;
    }
  }
  return integer;
}
