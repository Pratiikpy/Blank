import { createCofheConfig } from "@cofhe/react";
import { sepolia } from "@cofhe/sdk/chains";

// createCofheConfig now delegates to @cofhe/sdk/web's real config builder.
// The Vite alias routes "@cofhe/react" to our cofhe-shim.ts which uses the
// real SDK under the hood. The config is created as a singleton and cached.
// autogeneratePermits: on wallet/smart-account connect the SDK auto-creates a
// self-permit and signs it. Without this the user lands in a state where the
// balance is a ciphertext handle we can't decrypt — the eye toggle is
// useless because canUseRealDecrypt gates on an active permit. Auto-create
// also means the permit exists *before* the first encrypted read returns, so
// the decrypt path has nothing synchronous to do and doesn't stall the main
// thread right after shield.
export const cofheConfig = createCofheConfig({
  supportedChains: [sepolia],
  react: { autogeneratePermits: true },
});
