import { useMutation, useQuery } from '@apollo/client/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { router, useLocalSearchParams } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Banner, BannerText, Body, Button, Caption, Field, Screen } from '@/components/ui';
import { AccountsDocument, DepositDocument, TransferDocument } from '@/graphql/operations';
import { errorCode, errorMessage } from '@/lib/errors';
import { useIdempotencyKey } from '@/lib/idempotency';
import { formatMoney } from '@/lib/money';

const amount = z.string().trim().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/, 'Use a number like 150 or 150.25').refine((v) => !/^0(\.0+)?$/.test(v), 'Must be more than zero');
const uuid = z.string().trim().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Paste the recipient account id');

export default function MoveMoney() {
  const { mode, accountId } = useLocalSearchParams<{ mode: 'transfer' | 'deposit'; accountId: string }>();
  const isDeposit = mode === 'deposit';
  const idempotency = useIdempotencyKey();
  const account = useQuery(AccountsDocument, { fetchPolicy: 'cache-first' }).data?.accounts.find((a) => a.id === accountId);
  const schema = z.object({ amount, recipient: isDeposit ? z.string() : uuid, description: z.string().max(140) });
  const { control, handleSubmit, formState } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { amount: '', recipient: '', description: '' } });

  // No optimisticResponse: balances change on screen only after the server
  // committed the transfer (and again via the accountUpdated subscription).
  const refetchQueries = ['Accounts', 'Transactions', 'Portfolio'];
  const [transfer, transferState] = useMutation(TransferDocument, { refetchQueries });
  const [deposit, depositState] = useMutation(DepositDocument, { refetchQueries });
  const state = isDeposit ? depositState : transferState;

  async function onSubmit(values: z.infer<typeof schema>) {
    // A failed request (e.g. timeout after the server committed) keeps the
    // same key: tapping again returns the original result, never a 2nd transfer.
    const result = isDeposit
      ? await deposit({ variables: { input: { accountId, amount: values.amount, idempotencyKey: idempotency.key } } }).catch(() => null)
      : await transfer({
          variables: {
            input: { fromAccountId: accountId, toAccountId: values.recipient, amount: values.amount, idempotencyKey: idempotency.key, description: values.description || null },
          },
        }).catch(() => null);
    if (result?.data) {
      idempotency.rotate();
      router.back();
    }
  }

  return (
    <Screen keyboardShouldPersistTaps="handled">
      {account ? <Caption>From balance {formatMoney(account.balance.amount, account.currency)}</Caption> : null}
      {isDeposit ? (
        <Banner tone="info"><BannerText>Simulated deposit: play money for the demo, no real payment. Max 50,000.00 per deposit.</BannerText></Banner>
      ) : (
        <Controller control={control} name="recipient" render={({ field }) => (
          <Field label="Recipient account id" autoCapitalize="none" autoCorrect={false} value={field.value} onChangeText={field.onChange} error={formState.errors.recipient?.message} />
        )} />
      )}
      <Controller control={control} name="amount" render={({ field }) => (
        <Field label={`Amount (${account?.currency ?? ''})`} keyboardType="decimal-pad" value={field.value} onChangeText={field.onChange} error={formState.errors.amount?.message} />
      )} />
      {!isDeposit ? (
        <Controller control={control} name="description" render={({ field }) => (
          <Field label="Description (optional)" value={field.value} onChangeText={field.onChange} />
        )} />
      ) : null}
      {state.error ? (
        <Banner>
          <BannerText accessibilityRole="alert">
            {errorCode(state.error) === 'INSUFFICIENT_FUNDS' ? 'Not enough balance for this transfer.' : errorMessage(state.error)}
          </BannerText>
        </Banner>
      ) : null}
      <Button title={isDeposit ? 'Deposit' : 'Send'} loading={state.loading} onPress={() => void handleSubmit(onSubmit)()} />
      <Body secondary>Safe to retry: each transfer carries an idempotency key, so the server applies it once.</Body>
    </Screen>
  );
}
