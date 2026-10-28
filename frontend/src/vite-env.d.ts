/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Injected by vite.config.ts's `define` from backend/.env, not read from a
  // frontend .env file.
  readonly VITE_NETWORK_TEST_API_KEY?: string;
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  // package.json's version, for the report.
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
