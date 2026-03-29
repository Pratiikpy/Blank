import { createCofheConfig } from "@cofhe/react";
import { baseSepolia } from "@cofhe/sdk/chains";

export const cofheConfig = createCofheConfig({
  supportedChains: [baseSepolia],
});
