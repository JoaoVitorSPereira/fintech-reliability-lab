import { z } from 'zod';
import { isUuid } from '../../graphql/pagination';

export const orderSchema = z
  .object({
    assetId: z.string().refine(isUuid, 'Invalid asset id'),
    side: z.enum(['BUY', 'SELL']),
    type: z.enum(['MARKET', 'LIMIT']),
    quantity: z.string().max(40),
    limitPrice: z.string().max(40).nullish(),
    idempotencyKey: z
      .string()
      .regex(
        /^[A-Za-z0-9_-]{8,100}$/,
        'idempotencyKey must be 8-100 characters of [A-Za-z0-9_-]',
      ),
  })
  .refine((order) => (order.type === 'LIMIT') === (order.limitPrice != null), {
    message:
      'limitPrice is required for LIMIT orders and not allowed for MARKET orders',
  });

export type OrderInput = z.infer<typeof orderSchema>;
