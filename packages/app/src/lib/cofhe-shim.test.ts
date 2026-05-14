import { describe, it, expect, vi } from "vitest";
import { render, renderHook } from "@testing-library/react";
import { createElement } from "react";
import {
  Encryptable,
  FheTypes,
  _setActiveChainForShim,
  _subscribeSdkState,
  _resetSdkForChainChange,
  useCoingeckoUsdPrice,
  CofheProvider,
  createCofheConfig,
} from "./cofhe-shim";
import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "./constants";

// §15.x lib test for the Encryptable + FheTypes shim proxies. These
// fall back to hardcoded values until the real @cofhe/sdk loads, so
// the fallback shape MUST match @cofhe/sdk/core/types.ts FheTypes
// enum exactly. Callers that build encrypted-input shapes before
// connect would otherwise emit values that the SDK rejects (or
// worse, accepts with a wrong utype) on first encrypt.
//
// Source-of-truth comment in cofhe-shim.ts:
//   FheTypes enum: Bool=0, Uint4=1, Uint8=2, Uint16=3, Uint32=4,
//                  Uint64=5, Uint128=6, Uint160=7

describe("FheTypes proxy fallback", () => {
  it("Bool=0", () => expect(FheTypes.Bool).toBe(0));
  it("Uint4=1", () => expect(FheTypes.Uint4).toBe(1));
  it("Uint8=2", () => expect(FheTypes.Uint8).toBe(2));
  it("Uint16=3", () => expect(FheTypes.Uint16).toBe(3));
  it("Uint32=4", () => expect(FheTypes.Uint32).toBe(4));
  it("Uint64=5", () => expect(FheTypes.Uint64).toBe(5));
  it("Uint128=6", () => expect(FheTypes.Uint128).toBe(6));
  it("Uint160=7 / Address=7", () => {
    expect(FheTypes.Uint160).toBe(7);
    expect(FheTypes.Address).toBe(7);
  });

  it("returns 0 for unknown keys (defensive default)", () => {
    expect(FheTypes.NonExistentType).toBe(0);
  });
});

describe("Encryptable proxy fallback", () => {
  it("uint64 returns InEuint64 ABI tuple shape with utype=5", () => {
    const out = Encryptable.uint64(42);
    expect(out).toEqual({
      ctHash: 42n,
      securityZone: 0,
      utype: 5,
      signature: "0x",
    });
  });

  it("bool returns utype=0", () => {
    expect(Encryptable.bool(1).utype).toBe(0);
  });

  it("uint8 returns utype=2", () => {
    expect(Encryptable.uint8(42).utype).toBe(2);
  });

  it("uint16 returns utype=3", () => {
    expect(Encryptable.uint16(42).utype).toBe(3);
  });

  it("uint32 returns utype=4", () => {
    expect(Encryptable.uint32(42).utype).toBe(4);
  });

  it("uint128 returns utype=6", () => {
    expect(Encryptable.uint128(42).utype).toBe(6);
  });

  it("address returns utype=7 (matches FheTypes.Uint160 / Address)", () => {
    expect(Encryptable.address(42).utype).toBe(7);
  });

  it("converts the value to bigint regardless of input type", () => {
    expect(Encryptable.uint64(0).ctHash).toBe(0n);
    expect(Encryptable.uint64(1n).ctHash).toBe(1n);
    expect(Encryptable.uint64("123").ctHash).toBe(123n);
  });

  it("unknown encryptable key falls back to utype=4 (uint32)", () => {
    // Defensive default — keeps an unknown caller from emitting NaN.
    const out = Encryptable.notARealMethod(0);
    expect(out.utype).toBe(4);
  });
});

// §15.x extension: SDK state pub/sub coordination. The shim exposes
// `_subscribeSdkState` so React hooks can re-run their effects when
// the SDK finishes loading async after mount (issue #312) or after a
// `_resetSdkForChainChange` flush. A regression in the pub/sub
// primitives would break every cofhe-aware hook's reactivity on chain
// switch — silent: balances never refresh, decrypt calls hit the OLD
// chain's threshold network, contracts reject proofs as wrong-circuit.
describe("SDK state pub/sub (_subscribeSdkState / _resetSdkForChainChange)", () => {
  it("subscribed listeners fire when _resetSdkForChainChange runs", () => {
    const listener = vi.fn();
    const unsubscribe = _subscribeSdkState(listener);
    _resetSdkForChainChange();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("returned unsubscribe stops the listener from firing", () => {
    const listener = vi.fn();
    const unsubscribe = _subscribeSdkState(listener);
    unsubscribe();
    _resetSdkForChainChange();
    expect(listener).not.toHaveBeenCalled();
  });

  it("multiple listeners all fire on reset (set semantics, no shadowing)", () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const unsubs = [_subscribeSdkState(a), _subscribeSdkState(b), _subscribeSdkState(c)];
    _resetSdkForChainChange();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    for (const u of unsubs) u();
  });

  it("a listener that throws does NOT prevent other listeners from firing", () => {
    // The try-catch inside _notifySdkStateChange is load-bearing: without
    // it, one buggy hook's listener would stop every other hook's listener
    // from receiving the chain-change signal.
    const thrower = vi.fn(() => { throw new Error("listener bug"); });
    const after = vi.fn();
    const u1 = _subscribeSdkState(thrower);
    const u2 = _subscribeSdkState(after);
    expect(() => _resetSdkForChainChange()).not.toThrow();
    expect(thrower).toHaveBeenCalled();
    expect(after).toHaveBeenCalled();
    u1();
    u2();
  });

  it("re-subscribing the SAME listener function is deduplicated (Set semantics)", () => {
    // _sdkStateListeners is a Set — double-add is a no-op, but the test
    // pins the de-dupe so a future refactor to Array.push() would surface.
    const listener = vi.fn();
    const u1 = _subscribeSdkState(listener);
    const u2 = _subscribeSdkState(listener);
    _resetSdkForChainChange();
    expect(listener).toHaveBeenCalledTimes(1);
    u1();
    u2();
  });
});

// §15.x extension: _setActiveChainForShim drives which CoFHE chain
// (sepolia / baseSepolia) the next loadSdk() call configures. We
// can't directly observe the chain id from outside, but the call
// MUST not throw on the supported chain ids — pinned as a smoke
// check so a regression that added a require() / assertion behind
// the setter is surfaced.
describe("_setActiveChainForShim", () => {
  it("accepts ETH_SEPOLIA_ID without throwing", () => {
    expect(() => _setActiveChainForShim(ETH_SEPOLIA_ID)).not.toThrow();
  });

  it("accepts BASE_SEPOLIA_ID without throwing", () => {
    expect(() => _setActiveChainForShim(BASE_SEPOLIA_ID)).not.toThrow();
  });

  it("can be called multiple times (idempotent setter)", () => {
    expect(() => {
      _setActiveChainForShim(ETH_SEPOLIA_ID);
      _setActiveChainForShim(BASE_SEPOLIA_ID);
      _setActiveChainForShim(ETH_SEPOLIA_ID);
    }).not.toThrow();
  });
});

// §15.x extension: useCoingeckoUsdPrice + CofheProvider + createCofheConfig
// are intentional no-op stubs (real impls live in the dynamic-loaded
// @cofhe/react path). Pin their stub shapes so a future refactor that
// replaced them with real hooks WITHOUT updating the callers' optimistic
// access patterns would surface here.
describe("static stub exports", () => {
  it("useCoingeckoUsdPrice returns { data: 1.0, isLoading: false, error: null }", () => {
    const { result } = renderHook(() => useCoingeckoUsdPrice());
    expect(result.current).toEqual({ data: 1.0, isLoading: false, error: null });
  });

  it("CofheProvider is a passthrough (renders children verbatim)", () => {
    const { getByTestId } = render(
      createElement(
        CofheProvider,
        null,
        createElement("div", { "data-testid": "child" }, "child content"),
      ),
    );
    expect(getByTestId("child").textContent).toBe("child content");
  });

  it("createCofheConfig returns an empty object stub (real impl loads via loadSdk)", () => {
    expect(createCofheConfig({})).toEqual({});
    expect(createCofheConfig({ supportedChains: [1, 2] })).toEqual({});
  });
});
