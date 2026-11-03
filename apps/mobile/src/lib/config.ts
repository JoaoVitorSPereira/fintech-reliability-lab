// Public build-time config only. EXPO_PUBLIC_* values ship inside the app
// bundle: never put secrets here. The API URL is not a secret.
const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

export const config = {
  httpUrl: `${apiUrl.replace(/\/$/, '')}/graphql`,
  wsUrl: `${apiUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/graphql`,
};
