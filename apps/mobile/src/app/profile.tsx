import { useMutation, useQuery } from '@apollo/client/react';
import { Body, Button, Caption, Card, ErrorState, Loading, Row, Screen, SectionTitle } from '@/components/ui';
import { LogoutDocument, MeDocument, RevokeSessionDocument } from '@/graphql/operations';
import { errorMessage } from '@/lib/errors';
import { session } from '@/lib/session-instance';

export default function Profile() {
  // Security data: always from the server.
  const { data, loading, error, refetch } = useQuery(MeDocument, { fetchPolicy: 'network-only' });
  const [logout, logoutState] = useMutation(LogoutDocument);
  const [revoke] = useMutation(RevokeSessionDocument, { refetchQueries: ['Me'] });

  async function signOut() {
    await logout().catch(() => undefined); // revoke server-side if we can...
    await session.signOut(); // ...and always forget the tokens locally
  }

  if (!data && loading) return <Loading />;
  if (!data) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;
  return (
    <Screen>
      <Card>
        <Body bold>{data.me.email}</Body>
        <Caption>Member since {new Date(data.me.createdAt).toLocaleDateString()}</Caption>
      </Card>
      <Card>
        <SectionTitle>Signed-in devices</SectionTitle>
        {data.sessions.map((s) => (
          <Row key={s.id}>
            <Body>{s.deviceName ?? 'Unknown device'}{s.current ? ' (this device)' : ''}</Body>
            {s.current ? null : <Button title="Sign out" variant="secondary" onPress={() => void revoke({ variables: { id: s.id } }).catch(() => undefined)} />}
          </Row>
        ))}
      </Card>
      <Button title="Sign out" variant="danger" loading={logoutState.loading} onPress={() => void signOut()} />
    </Screen>
  );
}
