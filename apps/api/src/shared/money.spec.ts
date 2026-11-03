import { formatMinor, parsePositiveAmount } from './money';

describe('money', () => {
  it.each([
    [0n, '0.00'],
    [5n, '0.05'],
    [100000n, '1000.00'],
    [-123456n, '-1234.56'],
    [9_223_372_036_854_775_807n, '92233720368547758.07'],
  ])('formats %p minor units as %p', (minor, text) => {
    expect(formatMinor(minor, 'BRL')).toBe(text);
  });

  it.each([
    ['10', 1000n],
    ['10.5', 1050n],
    ['10.05', 1005n],
    ['0.01', 1n],
  ])('parses %p', (text, minor) => {
    expect(parsePositiveAmount(text, 'BRL')).toBe(minor);
  });

  it.each([
    '0',
    '0.00',
    '-1',
    '+1',
    '1e3',
    '10.505',
    '1,000.00',
    ' 1',
    '01',
    '',
    '.5',
    '1.',
  ])('rejects %p', (text) => {
    expect(parsePositiveAmount(text, 'BRL')).toBeNull();
  });

  it('round-trips', () => {
    expect(formatMinor(parsePositiveAmount('1234.5', 'BRL')!, 'BRL')).toBe(
      '1234.50',
    );
  });
});
