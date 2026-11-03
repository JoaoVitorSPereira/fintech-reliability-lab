import { useMutation } from '@apollo/client/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { KeyboardAvoidingView, Platform } from 'react-native';
import styled from 'styled-components/native';
import { z } from 'zod';
import { Banner, BannerText, Body, Button, Caption, Display, Field } from '@/components/ui';
import { SignInDocument } from '@/graphql/operations';
import { errorMessage } from '@/lib/errors';
import { session } from '@/lib/session-instance';

const schema = z.object({
  email: z.string().trim().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
});
type Form = z.infer<typeof schema>;

const Page = styled.View`
  flex: 1;
  justify-content: center;
  padding: ${({ theme }) => theme.spacing.xl}px;
  gap: ${({ theme }) => theme.spacing.lg}px;
  background-color: ${({ theme }) => theme.colors.background};
`;

export default function SignIn() {
  const [login, { loading, error }] = useMutation(SignInDocument);
  const { control, handleSubmit, formState } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });

  async function onSubmit(values: Form) {
    const { data } = await login({ variables: { input: { ...values, deviceName: `${Platform.OS} app` } } }).catch(() => ({ data: undefined }));
    if (data) await session.signIn(data.login);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Page>
        <Display>Reliability Lab</Display>
        <Body secondary>Banking ledger and paper trading on live market data.</Body>
        <Controller control={control} name="email" render={({ field }) => (
          <Field label="Email" autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" value={field.value} onChangeText={field.onChange} error={formState.errors.email?.message} />
        )} />
        <Controller control={control} name="password" render={({ field }) => (
          <Field label="Password" secureTextEntry autoComplete="current-password" textContentType="password" value={field.value} onChangeText={field.onChange} error={formState.errors.password?.message} />
        )} />
        {error ? <Banner><BannerText accessibilityRole="alert">{errorMessage(error)}</BannerText></Banner> : null}
        <Button title="Sign in" loading={loading} onPress={() => void handleSubmit(onSubmit)()} />
        <Link href="/sign-up" asChild>
          <Caption accessibilityRole="link" style={{ textAlign: 'center' }}>No account? Create one</Caption>
        </Link>
      </Page>
    </KeyboardAvoidingView>
  );
}
