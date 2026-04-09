/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILD_VERSION: string
  readonly VITE_BUILD_HASH: string
  readonly VITE_BUILD_DATE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
