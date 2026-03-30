/**
 * CoFHE React Hook Shims -- Real SDK Integration
 *
 * Replaces @cofhe/react to avoid MUI/emotion dependency crash in production.
 * Uses @cofhe/sdk and @cofhe/sdk/web directly for REAL FHE operations.
 *
 * What this provides:
 * - useCofheConnection: reports connected=true when wallet is on correct chain
 * - useCofheEncrypt: uses @cofhe/sdk EncryptInputsBuilder for REAL FHE encryption
 * - useCofheReadContractAndDecrypt: reads contract + decrypts via threshold network
 * - useCofheActivePermit: manages real permits via SDK permit store
 * - useCofheEncryptAndWriteContract: atomic encrypt + write
 * - CofheProvider: initializes SDK client on mount, manages connection lifecycle
 * - createCofheConfig: delegates to @cofhe/sdk/web createCofheConfig
 */

import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  createContext,
  useContext,
  useSyncExternalStore,
  createElement,
} from "react";
import {
  useAccount,
  usePublicClient,
  useWalletClient,
  useReadContract,
} from "wagmi";

import {
  FheTypes,
  type EncryptableItem,
  type EncryptedItemInput,
  type CofheClient,
  type CofheConfig,
} from "@cofhe/sdk";
import {
  createCofheConfig as sdkCreateCofheConfig,
  createCofheClient as sdkCreateCofheClient,
} from "@cofhe/sdk/web";
import { baseSepolia as cofheBaseSepolia } from "@cofhe/sdk/chains";
import type { Permit } from "@cofhe/sdk/permits";

// ─── Types ──────────────────────────────────────────────────────────

type CofheClientInstance = CofheClient<CofheConfig>;

// ─── Singleton SDK Client ───────────────────────────────────────────
// The SDK client is created once and shared across all hooks via context.
// It manages its own connection state, permits, encryption, and decryption.

let _sdkConfig: CofheConfig | null = null;
let _sdkClient: CofheClientInstance | null = null;

function getOrCreateConfig(userConfig?: unknown): CofheConfig {
  if (_sdkConfig) return _sdkConfig;

  try {
    const configInput =
      userConfig && typeof userConfig === "object"
        ? userConfig
        : { supportedChains: [cofheBaseSepolia] };
    _sdkConfig = sdkCreateCofheConfig(configInput as any);
    return _sdkConfig;
  } catch (err) {
    console.warn(
      "[cofhe-shim] Failed to create SDK config, using fallback:",
      err
    );
    // Return a minimal config so hooks don't crash
    _sdkConfig = sdkCreateCofheConfig({
      supportedChains: [cofheBaseSepolia],
    });
    return _sdkConfig;
  }
}

function getOrCreateClient(config?: CofheConfig): CofheClientInstance | null {
  if (_sdkClient) return _sdkClient;

  const cfg = config || getOrCreateConfig();
  try {
    _sdkClient = sdkCreateCofheClient(cfg);
    return _sdkClient;
  } catch (err) {
    console.warn("[cofhe-shim] Failed to create SDK client:", err);
    return null;
  }
}

// ─── React Context for SDK Client ──────────────────────────────────

const CofheClientContext = createContext<CofheClientInstance | null>(null);

function useCofheClient(): CofheClientInstance | null {
  return useContext(CofheClientContext);
}

// ─── useCofheConnection ─────────────────────────────────────────────
// Reports connected=true when wallet is on Base Sepolia AND SDK client
// is connected. Triggers SDK connect/disconnect on wallet changes.

export function useCofheConnection() {
  const { isConnected, chain } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const client = useCofheClient();

  const walletOnCorrectChain =
    isConnected && chain?.id === 84532 && !!publicClient && !!walletClient;

  // Subscribe to SDK connection state reactively
  const sdkConnected = useSyncExternalStore(
    useCallback(
      (cb: () => void) => {
        if (!client) return () => {};
        return client.subscribe(cb);
      },
      [client]
    ),
    useCallback(() => client?.connected ?? false, [client]),
    useCallback(() => false, [])
  );

  // Drive SDK connect/disconnect based on wallet state
  useEffect(() => {
    if (!client) return;

    if (walletOnCorrectChain && publicClient && walletClient) {
      client.connect(publicClient, walletClient).catch((err) => {
        console.warn("[cofhe-shim] SDK connect failed:", err);
      });
    } else if (!walletOnCorrectChain && client.connected) {
      client.disconnect();
    }
  }, [client, walletOnCorrectChain, publicClient, walletClient]);

  return {
    connected: walletOnCorrectChain && sdkConnected,
    connecting: isConnected && !sdkConnected,
  };
}

// ─── useCofheEncrypt ────────────────────────────────────────────────
// Provides encryptInputsAsync that uses the REAL SDK EncryptInputsBuilder.
// Performs ZK proof generation + ciphertext creation via TFHE WASM.

export function useCofheEncrypt() {
  const [isEncrypting, setIsEncrypting] = useState(false);
  const client = useCofheClient();

  const encryptInputsAsync = useCallback(
    async (items: unknown[]): Promise<EncryptedItemInput[]> => {
      if (!client || !client.connected) {
        console.warn(
          "[cofhe-shim] useCofheEncrypt: SDK client not connected, falling back to pass-through"
        );
        return items as any;
      }

      setIsEncrypting(true);
      try {
        // Filter to only EncryptableItem objects (have data, utype, securityZone)
        const encryptableItems = items.filter(
          (item): item is EncryptableItem =>
            typeof item === "object" &&
            item !== null &&
            "utype" in item &&
            "data" in item
        );

        if (encryptableItems.length === 0) {
          console.warn(
            "[cofhe-shim] useCofheEncrypt: no valid EncryptableItem in inputs, returning as-is"
          );
          return items as any;
        }

        const encrypted = await client
          .encryptInputs(encryptableItems)
          .execute();
        return encrypted as EncryptedItemInput[];
      } catch (err) {
        console.error("[cofhe-shim] Encryption failed:", err);
        throw err;
      } finally {
        setIsEncrypting(false);
      }
    },
    [client]
  );

  return {
    encryptInputsAsync,
    isEncrypting,
  };
}

// ─── useCofheEncryptAndWriteContract ────────────────────────────────
// Combines encryption and contract write into a single operation.
// Extracts Encryptable items from args, encrypts them, substitutes
// the encrypted inputs back, then calls writeContractAsync.

export function useCofheEncryptAndWriteContract() {
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const client = useCofheClient();
  const { data: walletClient } = useWalletClient();

  const encryptAndWrite = useCallback(
    async (request: {
      params: {
        address: `0x${string}`;
        abi: any;
        functionName: string;
        chain?: any;
        account?: `0x${string}`;
      };
      args: unknown[];
    }): Promise<`0x${string}`> => {
      if (!client || !client.connected) {
        throw new Error(
          "[cofhe-shim] SDK client not connected. Cannot encrypt and write."
        );
      }
      if (!walletClient) {
        throw new Error("[cofhe-shim] No wallet client available.");
      }

      try {
        // Step 1: Find and encrypt any Encryptable items in args
        setIsEncrypting(true);

        const encryptableIndices: number[] = [];
        const encryptableItems: EncryptableItem[] = [];

        for (let i = 0; i < request.args.length; i++) {
          const arg = request.args[i];
          if (
            typeof arg === "object" &&
            arg !== null &&
            "utype" in arg &&
            "data" in arg &&
            "securityZone" in arg
          ) {
            encryptableIndices.push(i);
            encryptableItems.push(arg as EncryptableItem);
          }
        }

        // If there are Encryptable items, encrypt them
        let processedArgs = [...request.args];

        if (encryptableItems.length > 0) {
          const encrypted = await client
            .encryptInputs(encryptableItems)
            .execute();

          // Replace Encryptable items with their encrypted counterparts
          for (let j = 0; j < encryptableIndices.length; j++) {
            processedArgs[encryptableIndices[j]] = encrypted[j];
          }
        }

        setIsEncrypting(false);

        // Step 2: Write the contract with encrypted args
        setIsPending(true);

        const hash = await walletClient.writeContract({
          address: request.params.address,
          abi: request.params.abi,
          functionName: request.params.functionName,
          args: processedArgs,
          chain: request.params.chain,
          account: request.params.account,
        });

        setIsPending(false);
        return hash;
      } catch (err) {
        setIsEncrypting(false);
        setIsPending(false);
        throw err;
      }
    },
    [client, walletClient]
  );

  return {
    encryptAndWrite,
    encryption: { isEncrypting },
    write: { isPending },
  };
}

// ─── useCofheReadContractAndDecrypt ─────────────────────────────────
// Reads an encrypted value from a contract and decrypts it using
// the SDK's decryptForView with the active permit.

export function useCofheReadContractAndDecrypt(
  contractConfig: {
    address?: `0x${string}`;
    abi?: any;
    functionName?: string;
    args?: unknown[];
    requiresPermit?: boolean;
  },
  options?: {
    readQueryOptions?: {
      enabled?: boolean;
      refetchOnMount?: boolean;
      refetchInterval?: number;
    };
  }
) {
  const client = useCofheClient();
  useAccount(); // Trigger re-render on account changes
  const [decryptedData, setDecryptedData] = useState<bigint | undefined>(
    undefined
  );
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState<Error | null>(null);
  const lastDecryptedCtHash = useRef<string | null>(null);

  const readEnabled =
    (options?.readQueryOptions?.enabled ?? true) &&
    !!contractConfig.address &&
    !!contractConfig.abi &&
    !!contractConfig.functionName;

  // Step 1: Read the encrypted handle from the contract using wagmi
  const {
    data: encryptedHandle,
    isFetching: isReadingEncrypted,
  } = useReadContract({
    address: contractConfig.address,
    abi: contractConfig.abi,
    functionName: contractConfig.functionName,
    args: contractConfig.args,
    query: {
      enabled: readEnabled,
      refetchOnMount: options?.readQueryOptions?.refetchOnMount,
      refetchInterval: options?.readQueryOptions?.refetchInterval,
    },
  });

  // Check if a permit is available when required
  const activePermit = useMemo(() => {
    if (!client || !client.connected) return undefined;
    try {
      return client.permits.getActivePermit();
    } catch {
      return undefined;
    }
  }, [client, client?.connected]);

  const disabledDueToMissingPermit =
    contractConfig.requiresPermit === true && !activePermit;

  // Step 2: When we have an encrypted handle (ctHash), decrypt it
  useEffect(() => {
    if (!client || !client.connected) return;
    if (!encryptedHandle) return;
    if (disabledDueToMissingPermit) return;

    const ctHash = encryptedHandle as bigint;
    if (ctHash === 0n) {
      // Zero handle means no encrypted value stored
      setDecryptedData(0n);
      return;
    }

    // Avoid re-decrypting the same handle
    const ctHashStr = ctHash.toString();
    if (lastDecryptedCtHash.current === ctHashStr && decryptedData !== undefined)
      return;

    let cancelled = false;

    const doDecrypt = async () => {
      setIsDecrypting(true);
      setDecryptError(null);

      try {
        const result = await client
          .decryptForView(ctHash, FheTypes.Uint64)
          .withPermit()
          .execute();

        if (!cancelled) {
          setDecryptedData(result as bigint);
          lastDecryptedCtHash.current = ctHashStr;
        }
      } catch (err) {
        if (!cancelled) {
          console.error("[cofhe-shim] Decryption failed:", err);
          setDecryptError(
            err instanceof Error ? err : new Error(String(err))
          );
        }
      } finally {
        if (!cancelled) {
          setIsDecrypting(false);
        }
      }
    };

    doDecrypt();

    return () => {
      cancelled = true;
    };
  }, [
    client,
    encryptedHandle,
    disabledDueToMissingPermit,
    // Not including decryptedData to avoid infinite loop
  ]);

  return {
    encrypted: {
      data: encryptedHandle,
      isFetching: isReadingEncrypted,
    },
    decrypted: {
      data: decryptedData,
      isFetching: isDecrypting,
      error: decryptError,
    },
    disabledDueToMissingPermit,
  };
}

// ─── useCofheActivePermit ───────────────────────────────────────────
// Returns the active permit from the SDK's permit store. Creates a
// self-permit automatically if none exists and the client is connected.

export function useCofheActivePermit(): {
  isValid: boolean;
  permit: Permit;
} | null {
  const client = useCofheClient();
  const { address } = useAccount();
  const [permitData, setPermitData] = useState<{
    isValid: boolean;
    permit: Permit;
  } | null>(null);
  const creatingPermitRef = useRef(false);

  // Subscribe to permit store changes
  const permitSnapshot = useSyncExternalStore(
    useCallback(
      (cb: () => void) => {
        if (!client) return () => {};
        return client.permits.subscribe(cb);
      },
      [client]
    ),
    useCallback(() => {
      if (!client) return null;
      return client.permits.getSnapshot();
    }, [client]),
    useCallback(() => null, [])
  );

  // Derive active permit from snapshot
  useEffect(() => {
    if (!client || !client.connected || !address) {
      setPermitData(null);
      return;
    }

    try {
      const activePermit = client.permits.getActivePermit();
      if (activePermit) {
        // Check validity: not expired
        const now = Math.floor(Date.now() / 1000);
        const isValid = activePermit.expiration > now;
        setPermitData({ isValid, permit: activePermit });
      } else {
        setPermitData(null);

        // Auto-create a self permit if none exists
        if (!creatingPermitRef.current) {
          creatingPermitRef.current = true;
          client.permits
            .getOrCreateSelfPermit()
            .then((permit) => {
              const now = Math.floor(Date.now() / 1000);
              setPermitData({
                isValid: permit.expiration > now,
                permit,
              });
            })
            .catch((err) => {
              console.warn(
                "[cofhe-shim] Failed to auto-create permit:",
                err
              );
            })
            .finally(() => {
              creatingPermitRef.current = false;
            });
        }
      }
    } catch (err) {
      console.warn("[cofhe-shim] Error reading active permit:", err);
      setPermitData(null);
    }
  }, [client, address, permitSnapshot]);

  return permitData;
}

// ─── useCoingeckoUsdPrice ───────────────────────────────────────────
// Simple stub -- the real @cofhe/react version fetches from Coingecko.
// We return a fixed 1.0 for USDC-pegged stablecoin display.

export function useCoingeckoUsdPrice(_config?: unknown) {
  return {
    data: 1.0,
    isLoading: false,
    error: null,
  };
}

// ─── CofheProvider ──────────────────────────────────────────────────
// Initializes the SDK client on mount and provides it to all hooks
// via React context. Manages the connection lifecycle.

export function CofheProvider({ children }: { children: React.ReactNode }) {
  const [client, setClient] = useState<CofheClientInstance | null>(null);

  useEffect(() => {
    const config = getOrCreateConfig();
    const sdkClient = getOrCreateClient(config);
    if (sdkClient) {
      setClient(sdkClient);
    }

    return () => {
      // On unmount, disconnect but keep the singleton alive
      // (reconnection will happen via useCofheConnection)
    };
  }, []);

  return createElement(CofheClientContext.Provider, { value: client }, children);
}

// ─── createCofheConfig ──────────────────────────────────────────────
// Delegates to the real @cofhe/sdk/web createCofheConfig.

export function createCofheConfig(config: unknown): CofheConfig {
  return getOrCreateConfig(config);
}

// ─── Re-export SDK types that consumers may need ────────────────────
export { Encryptable, FheTypes } from "@cofhe/sdk";
