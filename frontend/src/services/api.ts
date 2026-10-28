import axios from 'axios';
import type { NetworkTestConfig, TokenData } from '../types';

const API_BASE = '/api';

// Shared key for the gated endpoints. vite.config.ts injects it from
// backend/.env's NETWORK_TEST_API_KEY at build/dev-server start (there is no
// frontend/.env). It is discoverable by anyone who loads the page: it raises
// the bar against direct abuse of the token endpoint, which the rate limit
// and the captcha then hold.
const API_KEY = import.meta.env.VITE_NETWORK_TEST_API_KEY as string | undefined;

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
    ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
  },
});

// Human-readable copy for a failed backend request. axios's default message
// ("Request failed with status code 502") says nothing a tester can act on.
// The statuses are the backend's (utils/security.gate and the blueprint):
// 429 is the per-IP limit on test runs, 403 the captcha, 401/503 mean the key
// or the backend's configuration is off (the 503 body says which), 500 means
// a SignalWire REST call failed, the address listing or the mint (details in
// the backend log, never in the body), and 502/504 or no response at all mean
// Vite's /api proxy found nothing on :5001.
export const describeFetchError = (err: unknown, fallback: string): string => {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const serverMessage = (err.response?.data as { error?: unknown } | undefined)?.error;
    const detail = typeof serverMessage === 'string' ? serverMessage : null;
    if (status === 429) return 'Too many test runs from this address — wait ten minutes and try again.';
    if (status === 403) {
      return detail === 'Captcha rejected'
        ? 'The captcha was rejected — reload the page and try again.'
        : 'The captcha is required — complete it, then start the test.';
    }
    if (status === 401) return 'The backend rejected the API key — restart the dev server after changing NETWORK_TEST_API_KEY.';
    if (status === 503) return `${detail ?? 'Backend unavailable'} — check backend/.env and the backend log.`;
    if (status === 500) return "The backend couldn't mint a token — check its log.";
    if (status === 400) return detail ?? fallback;
    if (status === 502 || status === 504 || !err.response) return 'Backend unreachable — is the Flask server running on :5001?';
  }
  return err instanceof Error ? err.message : fallback;
};

export const networkTestAPI = {
  async config(): Promise<NetworkTestConfig> {
    const response = await api.get<{ success: boolean; data: NetworkTestConfig }>('/network-test/config');
    if (!response.data.success) {
      throw new Error('Failed to load the test configuration');
    }
    return response.data.data;
  },

  // One token per run. The captcha token is single-use on the server, so a
  // caller passes it once and clears it.
  async token(region: string, captchaToken: string | null): Promise<TokenData> {
    const response = await api.post<{ success: boolean; data: TokenData }>('/network-test/token', {
      region,
      ...(captchaToken ? { captcha_token: captchaToken } : {}),
    });
    if (!response.data.success) {
      throw new Error('Failed to get a token');
    }
    return response.data.data;
  },
};
