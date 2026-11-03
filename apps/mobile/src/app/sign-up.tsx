import { useMutation } from '@apollo/client/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { Platform } from 'react-native';
import { z } from 'zod';
import { Banner, BannerText, Button, Caption, Field, Screen } from '@/components/ui';
import { SignUpDocument } from '@/graphql/operations';
import { errorMessage } from '@/lib/errors';
import { session } from '@/lib/session-instance';

// Same rules as the server (NIST: length, not composition). The server is
// still the authority; this only saves a round trip.
const schema = z.object({
  email: z.string().trim().email('Enter a valid email'),
  password: z.string().min(15, 'At least 15 characters').max(128, 'At most 128 characters'),
});
type Form = z.infer<typeof schema>;

export default function SignUp() {
  const [register, { loading, error }] = useMutation(SignUpDocument);
  const { control, handleSubmit, formState } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });

  async function onSubmit(values: Form) {
    const { data } = await register({ variables: { input: { ...values, deviceName: `${Platform.OS} app` } } }).catch(() => ({ data: undefined }));
    if (data) await session.signIn(data.register);
  }

  return (
    <Screen keyboardShouldPersistTaps="handled">
      <Controller control={control} name="email" render={({ field }) => (
        <Field label="Email" autoCapitalize="none" keyboardType="email-address" autoComplete="email" value={field.value} onChangeText={field.onChange} error={formState.errors.email?.message} />
      )} />
      <Controller control={control} name="password" render={({ field }) => (
        <Field label="Password" secureTextEntry autoComplete="new-password" textContentType="newPassword" value={field.value} onChangeText={field.onChange} error={formState.errors.password?.message} />
      )} />
      <Caption>Use a passphrase of 15+ characters. You get a BRL account and can open a paper-trading portfolio.</Caption>
      {error ? <Banner><BannerText accessibilityRole="alert">{errorMessage(error)}</BannerText></Banner> : null}
      <Button title="Create account" loading={loading} onPress={() => void handleSubmit(onSubmit)()} />
    </Screen>
  );
}
