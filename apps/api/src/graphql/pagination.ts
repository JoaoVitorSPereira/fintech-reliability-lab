import { Field, ObjectType } from '@nestjs/graphql';
import { AppError } from '../shared/errors/app-error';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PAGE_SIZE = 100;

@ObjectType()
export class PageInfo {
  @Field(() => String, { nullable: true })
  endCursor: string | null;

  @Field()
  hasNextPage: boolean;
}

// Keyset pagination: the cursor is the last row's UUIDv7 id (time-ordered).
// Opaque to clients so the encoding can change without breaking them.
// Unlike OFFSET, new rows arriving while a user scrolls never shift the page.
export function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

export function decodeCursor(
  cursor: string | null | undefined,
): string | undefined {
  if (cursor == null) return undefined;
  const id = Buffer.from(cursor, 'base64url').toString();
  if (!UUID.test(id)) throw new AppError('BAD_USER_INPUT', 'Invalid cursor.');
  return id;
}

export function pageSize(first: number): number {
  if (!Number.isInteger(first) || first < 1 || first > MAX_PAGE_SIZE) {
    throw new AppError(
      'BAD_USER_INPUT',
      `first must be between 1 and ${MAX_PAGE_SIZE}.`,
    );
  }
  return first;
}

/** Fetch `size + 1` rows, then call this: the extra row only signals "more". */
export function toPage<T extends { id: string }>(rows: T[], size: number) {
  const nodes = rows.slice(0, size);
  const last = nodes.at(-1);
  return {
    nodes,
    pageInfo: {
      endCursor: last ? encodeCursor(last.id) : null,
      hasNextPage: rows.length > size,
    },
  };
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
