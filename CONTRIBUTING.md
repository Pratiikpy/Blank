# Contributing to Blank

Thanks for contributing.

This repository ships a live public testnet product. Please optimize for
correctness, clear scope, and reproducibility over speed.

## Ground rules

- Keep claims honest. Do not describe unverified behavior as complete.
- Preserve existing product boundaries in README, launch docs, and public copy.
- Use small, surgical pull requests when possible.
- Keep contract upgrades storage-safe. `pnpm storage:check` must pass.
- Do not commit secrets, seed phrases, private keys, funded test wallets, or
  local profile data.

## Local setup

```bash
pnpm install --frozen-lockfile
```

App:

```bash
cd packages/app
pnpm dev
```

Contracts:

```bash
cd packages/contracts
pnpm exec hardhat compile
pnpm exec hardhat test
```

## Required checks before PR

From repo root:

```bash
pnpm --dir packages/app exec tsc --noEmit
pnpm --dir packages/app check:imports
pnpm --dir packages/app check:voice:strict
pnpm --dir packages/contracts exec hardhat test
pnpm --dir packages/contracts storage:check
```

Run additional flow-specific tests for the files you touched.

## Pull request format

Please include:

1. Scope summary: what changed and why.
2. Risk summary: what could regress.
3. Evidence: test commands and outcomes.
4. Live impact: any changes to public routes, copy, or launch boundaries.

If your change affects public marketing/docs surfaces, verify:

- canonical domains are `*.myblank.app`
- no overclaims about mainnet readiness
- no claim of automatic digital delivery unless implemented

## Security reporting

Do not open a public issue for vulnerabilities.
Use the private reporting path in [SECURITY.md](SECURITY.md).
