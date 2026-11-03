import { formatCompact, formatMoney, formatPercent, formatPrice } from '../money';

describe('money formatting (exact strings, never floats)', () => {
  it('formats amounts with grouping and currency', () => {
    expect(formatMoney('1050.25', 'BRL')).toBe('R$1,050.25');
    expect(formatMoney('-300.5', 'USD')).toBe('-$300.50');
    expect(formatMoney('12.5', 'USD', { signed: true })).toBe('+$12.50');
    expect(formatMoney('0.00', 'USD', { signed: true })).toBe('$0.00');
  });

  it('keeps precision beyond what a JS number can hold', () => {
    expect(formatMoney('92233720368547758.07', 'BRL')).toBe('R$92,233,720,368,547,758.07');
  });

  it('formats prices by magnitude', () => {
    expect(formatPrice('77158.01')).toBe('77,158.01');
    expect(formatPrice('0.00000012')).toBe('0.0000001200');
    expect(formatPrice('0.99873')).toBe('0.9987');
  });

  it('formats percentages and compact numbers', () => {
    expect(formatPercent('-1.58492')).toBe('-1.58%');
    expect(formatPercent('12.5')).toBe('+12.50%');
    expect(formatPercent(null)).toBe('—');
    expect(formatCompact('1543999804108')).toBe('1.54T');
    expect(formatCompact('25339862715')).toBe('25.33B');
  });
});
