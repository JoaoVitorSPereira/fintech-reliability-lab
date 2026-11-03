import { mergeConnection } from '../pagination';

const merge = mergeConnection as unknown as (existing: unknown, incoming: unknown, options: { args: Record<string, unknown> | null }) => { nodes: { __ref: string }[] };

describe('mergeConnection', () => {
  const page = (...refs: string[]) => ({ nodes: refs.map((__ref) => ({ __ref })), pageInfo: {} });

  it('appends next pages and drops duplicates', () => {
    const result = merge(page('a', 'b'), page('b', 'c'), { args: { after: 'cursor' } });
    expect(result.nodes.map((n) => n.__ref)).toEqual(['a', 'b', 'c']);
  });

  it('replaces the list when the first page is fetched again (pull to refresh)', () => {
    const result = merge(page('a', 'b'), page('z'), { args: {} });
    expect(result.nodes.map((n) => n.__ref)).toEqual(['z']);
  });
});
