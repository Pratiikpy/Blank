import { expect } from "chai";
import {
  stripAstIds,
  layoutsEqual,
  stableStringify,
  type StorageLayout,
} from "../tasks/check-storage-layout";

// §15.x test for the storage-layout-check pure helpers. These functions
// gate every UUPS upgrade: a regression here would either false-positive
// (flag every external SDK bump as a layout change, breaking CI on
// `pnpm storage:check` for runs with no real diff) or false-negative
// (miss a real storage reorder that bricks user state post-upgrade —
// catastrophic, irreversible on-chain).
//
// The AST-id stripping logic is the subtle part: solc emits sequential
// AST-ids embedded in type strings (`t_contract(IEventHub)45306`) and
// as top-level `astId` fields. AST-ids are per-compilation counters,
// so a @cofhe/mock-contracts SDK bump shifts every id even though
// slot/offset/label/type-shape stay identical. UUPS upgrade safety
// depends ONLY on slot/offset/label/type-shape, so stripping AST-ids
// before comparing is correct AND necessary.

describe("stripAstIds (storage-layout helper)", () => {
  it("returns pure-digit strings unchanged (slot numbers + offsets must survive)", () => {
    expect(stripAstIds("0")).to.equal("0");
    expect(stripAstIds("42")).to.equal("42");
    expect(stripAstIds("12345")).to.equal("12345");
  });

  it("strips digit runs from mixed strings (type expressions with embedded AST-ids)", () => {
    expect(stripAstIds("t_contract(IEventHub)45306")).to.equal("t_contract(IEventHub)");
    expect(stripAstIds("t_userDefinedValueType(euint)4733")).to.equal(
      "t_userDefinedValueType(euint)"
    );
    expect(stripAstIds("t_struct(Invoice)123_storage")).to.equal("t_struct(Invoice)_storage");
  });

  it("drops top-level astId fields from objects", () => {
    const input = { astId: 4733, label: "myVar", slot: "0", offset: 0, type: "t_uint256" };
    const out = stripAstIds(input) as Record<string, unknown>;
    expect(out).to.not.have.property("astId");
    expect(out.label).to.equal("myVar");
    expect(out.slot).to.equal("0");
    expect(out.type).to.equal("t_uint");
  });

  it("drops astId fields recursively across nested structures", () => {
    const input = {
      storage: [
        { astId: 100, label: "a", slot: "0" },
        { astId: 200, label: "b", slot: "1" },
      ],
      types: {
        "t_struct(X)123_storage": {
          astId: 300,
          label: "struct X",
          members: [{ astId: 400, label: "field1" }],
        },
      },
    };
    const out = stripAstIds(input);
    const serialized = JSON.stringify(out);
    expect(serialized).to.not.include("astId");
    expect(serialized).to.not.include("100");
    expect(serialized).to.not.include("200");
    expect(serialized).to.not.include("300");
    expect(serialized).to.not.include("400");
  });

  it("strips digit runs from object keys (types map keys carry embedded AST-ids)", () => {
    const input = {
      "t_struct(Invoice)123_storage": { label: "Invoice" },
      "t_contract(IFoo)456": { label: "IFoo" },
    };
    const out = stripAstIds(input) as Record<string, unknown>;
    expect(Object.keys(out)).to.deep.equal([
      "t_struct(Invoice)_storage",
      "t_contract(IFoo)",
    ]);
  });

  it("leaves pure-digit object keys alone (preserves numeric maps if any)", () => {
    const input = { "0": "first", "1": "second", "42": "answer" };
    const out = stripAstIds(input) as Record<string, unknown>;
    expect(Object.keys(out)).to.deep.equal(["0", "1", "42"]);
  });

  it("recursively strips inside arrays", () => {
    const input = ["t_uint256_42", "t_address_99", { astId: 1, label: "x" }];
    const out = stripAstIds(input) as unknown[];
    expect(out[0]).to.equal("t_uint_");
    expect(out[1]).to.equal("t_address_");
    expect(out[2]).to.deep.equal({ label: "x" });
  });

  it("passes through non-string non-object primitives (null, undefined, boolean, number)", () => {
    expect(stripAstIds(null)).to.equal(null);
    expect(stripAstIds(undefined)).to.equal(undefined);
    expect(stripAstIds(true)).to.equal(true);
    expect(stripAstIds(false)).to.equal(false);
    expect(stripAstIds(42)).to.equal(42);
  });

  it("returns empty arrays + empty objects unchanged in shape", () => {
    expect(stripAstIds([])).to.deep.equal([]);
    expect(stripAstIds({})).to.deep.equal({});
  });
});

describe("layoutsEqual (storage-layout helper)", () => {
  function makeLayout(extras: Partial<StorageLayout> = {}): StorageLayout {
    return {
      storage: [{ astId: 100, label: "value", slot: "0", offset: 0, type: "t_uint256" }],
      types: { t_uint256: { label: "uint256", numberOfBytes: "32" } },
      ...extras,
    };
  }

  it("two identical layouts compare equal", () => {
    expect(layoutsEqual(makeLayout(), makeLayout())).to.equal(true);
  });

  it("layouts differing ONLY in AST-ids compare equal (the whole point of stripping)", () => {
    const a = makeLayout({
      storage: [{ astId: 100, label: "value", slot: "0", offset: 0, type: "t_uint256" }],
    });
    const b = makeLayout({
      storage: [{ astId: 99999, label: "value", slot: "0", offset: 0, type: "t_uint256" }],
    });
    expect(layoutsEqual(a, b)).to.equal(true);
  });

  it("layouts differing ONLY in embedded type-id digits compare equal", () => {
    const a = makeLayout({
      storage: [{ astId: 1, label: "owner", slot: "0", offset: 0, type: "t_contract(IFoo)123" }],
    });
    const b = makeLayout({
      storage: [{ astId: 1, label: "owner", slot: "0", offset: 0, type: "t_contract(IFoo)45678" }],
    });
    expect(layoutsEqual(a, b)).to.equal(true);
  });

  it("layouts with reordered slots compare UNEQUAL (the catastrophic UUPS regression)", () => {
    const a = makeLayout({
      storage: [
        { astId: 1, label: "owner", slot: "0", offset: 0, type: "t_address" },
        { astId: 2, label: "paused", slot: "1", offset: 0, type: "t_bool" },
      ],
    });
    const b = makeLayout({
      storage: [
        { astId: 1, label: "owner", slot: "1", offset: 0, type: "t_address" },
        { astId: 2, label: "paused", slot: "0", offset: 0, type: "t_bool" },
      ],
    });
    expect(layoutsEqual(a, b)).to.equal(false);
  });

  it("layouts with a renamed slot compare UNEQUAL (label is part of the diff surface)", () => {
    const a = makeLayout({
      storage: [{ astId: 1, label: "owner", slot: "0", offset: 0, type: "t_address" }],
    });
    const b = makeLayout({
      storage: [{ astId: 1, label: "operator", slot: "0", offset: 0, type: "t_address" }],
    });
    expect(layoutsEqual(a, b)).to.equal(false);
  });

  it("layouts with a type change at the same slot compare UNEQUAL (type-shape matters)", () => {
    // Use types that don't collide after digit-stripping. uint256 vs
    // uint128 both reduce to "t_uint_" so a stripAstIds-based compare
    // would miss that specific change (the real-world detection comes
    // from the types-map content diff). t_uint256 vs t_address is the
    // clean case: different kinds entirely.
    const a = makeLayout({
      storage: [{ astId: 1, label: "value", slot: "0", offset: 0, type: "t_uint256" }],
    });
    const b = makeLayout({
      storage: [{ astId: 1, label: "value", slot: "0", offset: 0, type: "t_address" }],
    });
    expect(layoutsEqual(a, b)).to.equal(false);
  });

  it("uint256 -> uint128 at the same slot is detected via the types-map diff (numberOfBytes)", () => {
    // The realistic shape: when source changes uint256 to uint128,
    // solc emits a different types-map entry (numberOfBytes 32 -> 16).
    // The stripAstIds-based compare picks it up via the types diff
    // even though the storage entry's bare type string would collide.
    const a: StorageLayout = {
      storage: [{ astId: 1, label: "value", slot: "0", offset: 0, type: "t_uint256" }],
      types: { t_uint256: { label: "uint256", numberOfBytes: "32", encoding: "inplace" } },
    };
    const b: StorageLayout = {
      storage: [{ astId: 1, label: "value", slot: "0", offset: 0, type: "t_uint128" }],
      types: { t_uint128: { label: "uint128", numberOfBytes: "16", encoding: "inplace" } },
    };
    expect(layoutsEqual(a, b)).to.equal(false);
  });

  it("layouts with a new slot appended compare UNEQUAL (append-only is still a change)", () => {
    const a = makeLayout({
      storage: [{ astId: 1, label: "owner", slot: "0", offset: 0, type: "t_address" }],
    });
    const b = makeLayout({
      storage: [
        { astId: 1, label: "owner", slot: "0", offset: 0, type: "t_address" },
        { astId: 2, label: "newField", slot: "1", offset: 0, type: "t_uint256" },
      ],
    });
    // Append-only is the SAFE form of layout change, but the helper
    // still flags it so the caller can review + bless via --write.
    expect(layoutsEqual(a, b)).to.equal(false);
  });

  it("layouts with the same content but types-map keyed by different AST-ids compare equal", () => {
    const a: StorageLayout = {
      storage: [],
      types: { "t_struct(Invoice)123_storage": { label: "Invoice" } },
    };
    const b: StorageLayout = {
      storage: [],
      types: { "t_struct(Invoice)99999_storage": { label: "Invoice" } },
    };
    expect(layoutsEqual(a, b)).to.equal(true);
  });

  it("layouts where one has null types and the other has empty-object types compare UNEQUAL", () => {
    // null vs {} is the real edge case: solc emits null when no custom
    // types exist; an empty-object types could happen via a bad merge.
    // Pinned to surface this asymmetry instead of silently treating
    // them as equivalent.
    const a: StorageLayout = { storage: [], types: null };
    const b: StorageLayout = { storage: [], types: {} };
    expect(layoutsEqual(a, b)).to.equal(false);
  });
});

describe("stableStringify (storage-layout helper)", () => {
  it("produces identical output for objects with the same content but different key insertion order", () => {
    const a = { c: 3, a: 1, b: 2 };
    const b = { a: 1, b: 2, c: 3 };
    expect(stableStringify(a)).to.equal(stableStringify(b));
  });

  it("emits multi-line indented JSON (2-space indent, readable in CI logs)", () => {
    const out = stableStringify({ key: "value" });
    expect(out).to.include("\n");
    expect(out).to.include("  \"key\"");
  });
});
