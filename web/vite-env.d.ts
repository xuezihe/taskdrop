/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly TASKDROP_MCP_ORIGIN?: string;
  readonly VITE_TASKDROP_MCP_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
