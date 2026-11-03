import { useMutation, useQuery } from '@apollo/client/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Banner, BannerText, Body, Button, Caption, Card, Field, Row, Screen, SegmentedControl } from '@/components/ui';
import type { OrderFieldsFragment } from '@/graphql/generated/graphql';
import { AssetDetailDocument, CreatePortfolioDocument, PlaceOrderDocument, PortfolioDocument } from '@/graphql/operations';
import { errorMessage } from '@/lib/errors';
import { useIdempotencyKey } from '@/lib/idempotency';
import { formatMoney, formatPrice } from '@/lib/money';

const decimal = z.string().trim().regex(/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/, 'Up to 8 decimal places');
const schema = z.object({ quantity: decimal, limitPrice: z.string().trim() });
type Form = z.infer<typeof schema>;

export default function TradeSheet() {
  const params = useLocalSearchParams<{ assetId: string; side?: 'BUY' | 'SELL' }>();
  const [side, setSide] = useState<'BUY' | 'SELL'>(params.side ?? 'BUY');
  const [type, setType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [result, setResult] = useState<OrderFieldsFragment | null>(null);
  const idempotency = useIdempotencyKey();

  const asset = useQuery(AssetDetailDocument, { variables: { id: params.assetId }, fetchPolicy: 'cache-first' }).data?.asset;
  const portfolio = useQuery(PortfolioDocument, { fetchPolicy: 'cache-and-network' });
  const [createPortfolio, creating] = useMutation(CreatePortfolioDocument, { refetchQueries: ['Portfolio'] });
  // No optimistic response: an order is shown as filled only when the server says so.
  const [placeOrder, placing] = useMutation(PlaceOrderDocument, { refetchQueries: ['Portfolio', 'Orders', 'Dashboard'] });

  const { control, handleSubmit, formState, setError } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { quantity: '', limitPrice: '' } });

  async function onSubmit(values: Form) {
    if (type === 'LIMIT' && !decimal.safeParse(values.limitPrice).success) {
      setError('limitPrice', { message: 'Enter a limit price' });
      return;
    }
    const { data } = await placeOrder({
      variables: {
        input: {
          assetId: params.assetId, side, type, quantity: values.quantity,
          limitPrice: type === 'LIMIT' ? values.limitPrice : null,
          idempotencyKey: idempotency.key,
        },
      },
    }).catch(() => ({ data: undefined })); // network error: same key on retry, so no duplicate order
    if (data) {
      setResult(data.createSimulatedOrder.order);
      idempotency.rotate();
    }
  }

  const p = portfolio.data?.portfolio;
  if (portfolio.data && !p) {
    return (
      <Screen>
        <Body>Paper trading needs a portfolio with play money.</Body>
        <Button title="Create portfolio" loading={creating.loading} onPress={() => void createPortfolio().catch(() => undefined)} />
      </Screen>
    );
  }
  const quote = asset?.quote;

  return (
    <Screen keyboardShouldPersistTaps="handled">
      <Banner tone="info"><BannerText>SIMULATED. Fills in full at the latest market-data price, with no spread, fees or order book.</BannerText></Banner>
      <Row>
        <Body bold>{asset?.symbol}</Body>
        <Caption>{quote ? `${formatPrice(quote.price)} ${quote.currency} · ${quote.dataQuality}` : 'No price'}</Caption>
      </Row>
      {p ? <Caption>Available cash {formatMoney(p.cash.amount, 'USD')}</Caption> : null}
      <SegmentedControl options={['BUY', 'SELL'] as const} value={side} onChange={setSide} labels={{ BUY: 'Buy', SELL: 'Sell' }} />
      <SegmentedControl options={['MARKET', 'LIMIT'] as const} value={type} onChange={setType} labels={{ MARKET: 'Market', LIMIT: 'Limit' }} />
      <Controller control={control} name="quantity" render={({ field }) => (
        <Field label="Quantity (units)" keyboardType="decimal-pad" value={field.value} onChangeText={field.onChange} error={formState.errors.quantity?.message} />
      )} />
      {type === 'LIMIT' ? (
        <Controller control={control} name="limitPrice" render={({ field }) => (
          <Field label="Limit price (USD)" keyboardType="decimal-pad" value={field.value} onChangeText={field.onChange} error={formState.errors.limitPrice?.message} />
        )} />
      ) : null}
      {placing.error ? <Banner><BannerText accessibilityRole="alert">{errorMessage(placing.error)}</BannerText></Banner> : null}
      <Button title={`Place ${side === 'BUY' ? 'buy' : 'sell'} order`} loading={placing.loading} onPress={() => void handleSubmit(onSubmit)()} />

      {result ? (
        <Card>
          <Body bold>Order {result.status.toLowerCase()}</Body>
          {result.rejectReason ? <Caption>{result.rejectReason}</Caption> : null}
          {result.trade ? <Caption>{result.trade.quantity} @ {formatPrice(result.trade.price)} = {formatMoney(result.trade.notional.amount, 'USD')} · price from {result.trade.priceProvider}</Caption> : null}
          {result.status === 'PENDING' ? <Caption>Waiting for the price to reach your limit. Held {formatMoney(result.reservedCash.amount, 'USD')}.</Caption> : null}
          <Button title="Done" variant="secondary" onPress={() => router.back()} />
        </Card>
      ) : null}
    </Screen>
  );
}
