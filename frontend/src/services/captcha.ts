// Cloudflare Turnstile, rendered explicitly into a mount the page owns. The
// site key comes from backend/.env's TURNSTILE_SITE_KEY through
// vite.config.ts; without it the page sends no captcha token (local
// development; the backend decides whether that is allowed).

export interface TurnstileOptions {
  sitekey: string;
  callback: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact' | 'flexible';
}

export interface TurnstileApi {
  render: (el: HTMLElement, options: TurnstileOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export const TURNSTILE_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) || null;

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let loading: Promise<TurnstileApi> | null = null;

export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    loading = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.async = true;
      script.onload = () => {
        if (window.turnstile) resolve(window.turnstile);
        else reject(new Error('The captcha script loaded but exposed no API'));
      };
      script.onerror = () => {
        loading = null;
        reject(new Error('The captcha script could not be loaded'));
      };
      document.head.appendChild(script);
    });
  }
  return loading;
}
