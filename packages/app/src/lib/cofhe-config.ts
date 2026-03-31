import { createCofheConfig } from "@cofhe/react";
import { sepolia } from "@cofhe/sdk/chains";

// createCofheConfig now delegates to @cofhe/sdk/web's real config builder.
// The Vite alias routes "@cofhe/react" to our cofhe-shim.ts which uses the
// real SDK under the hood. The config is created as a singleton and cached.
export const cofheConfig = createCofheConfig({
  supportedChains: [sepolia],
});
