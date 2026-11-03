import type { FieldMergeFunction } from '@apollo/client';

type Connection = { nodes?: readonly { __ref?: string }[]; pageInfo?: unknown };

// Cursor pages are appended; a first page (no `after`) replaces the list, so
// pull-to-refresh starts over. Duplicate refs (a row that shifted between
// pages) are dropped.
export const mergeConnection: FieldMergeFunction<Connection, Connection> = (existing, incoming, { args }) => {
  if (!existing || !args?.['after']) return incoming;
  const seen = new Set((existing.nodes ?? []).map((node) => node.__ref));
  return {
    ...incoming,
    nodes: [...(existing.nodes ?? []), ...(incoming.nodes ?? []).filter((node) => !seen.has(node.__ref))],
  };
};
