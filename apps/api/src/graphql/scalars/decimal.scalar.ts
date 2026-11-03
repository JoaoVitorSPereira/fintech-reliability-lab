import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

function check(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !DECIMAL.test(value)) {
    throw new GraphQLError(
      'Decimal must be a plain decimal string such as "1050.25".',
      {
        extensions: { code: 'BAD_USER_INPUT' },
      },
    );
  }
  return value;
}

// Exact decimals as strings, both ways. Not a Float (binary floating point
// can't represent 0.1) and not an Int (32-bit, R$21M in centavos). Clients
// must keep these as strings or decimal types, never JS numbers.
export const DecimalScalar = new GraphQLScalarType({
  name: 'Decimal',
  description:
    'An exact decimal number serialized as a string, e.g. "1050.25". Never parse into a float.',
  serialize: (value) => check(value),
  parseValue: (value) => check(value),
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(
        'Decimal literals must be strings, e.g. "1050.25".',
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    return check(ast.value);
  },
});
