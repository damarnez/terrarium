/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_ROUTER_ADDRESS?: string;
  readonly VITE_TOKEN_ADDRESS?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_SUBGRAPH_URL?: string;
  readonly VITE_TERRARIUM?: string;
}
