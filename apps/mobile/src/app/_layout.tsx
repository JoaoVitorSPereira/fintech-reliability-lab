import { ApolloProvider } from '@apollo/client/react';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavigationTheme } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { ThemeProvider } from 'styled-components/native';
import { useSessionStatus } from '@/hooks/use-session';
import { apolloClient } from '@/lib/apollo';
import { session } from '@/lib/session-instance';
import { makeTheme } from '@/theme/theme';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const theme = useMemo(() => makeTheme(scheme), [scheme]);
  const status = useSessionStatus();

  useEffect(() => {
    void session.restore();
  }, []);

  useEffect(() => {
    if (status !== 'unknown') void SplashScreen.hideAsync();
  }, [status]);

  if (status === 'unknown') return null; // splash stays up while the session is restored

  const navigationTheme = scheme === 'dark' ? DarkTheme : DefaultTheme;
  return (
    <ApolloProvider client={apolloClient}>
      <ThemeProvider theme={theme}>
        <NavigationTheme value={{ ...navigationTheme, colors: { ...navigationTheme.colors, background: theme.colors.background } }}>
          <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
            <Stack.Protected guard={status === 'signedIn'}>
              <Stack.Screen name="(app)" options={{ headerShown: false }} />
              <Stack.Screen name="asset/[id]" options={{ title: '' }} />
              <Stack.Screen name="trade/[assetId]" options={{ presentation: 'formSheet', title: 'Simulated order', sheetAllowedDetents: [0.75, 1] }} />
              <Stack.Screen name="transfer" options={{ presentation: 'modal', title: 'Move money' }} />
              <Stack.Screen name="profile" options={{ presentation: 'modal', title: 'Profile' }} />
            </Stack.Protected>
            <Stack.Protected guard={status === 'signedOut'}>
              <Stack.Screen name="sign-in" options={{ headerShown: false }} />
              <Stack.Screen name="sign-up" options={{ title: 'Create account' }} />
            </Stack.Protected>
          </Stack>
        </NavigationTheme>
      </ThemeProvider>
    </ApolloProvider>
  );
}
