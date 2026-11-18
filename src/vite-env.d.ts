/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string
}

declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string

interface ImportMeta {
  readonly env: ImportMetaEnv
}
