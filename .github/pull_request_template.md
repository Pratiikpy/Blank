## Summary

Describe what changed and why.

## Scope

- [ ] App (`packages/app`)
- [ ] Contracts (`packages/contracts`)
- [ ] Public docs/copy (`README`, `docs`, landing pages)
- [ ] CI/workflows

## Verification

List exact commands run and outcomes.

```bash
# example
pnpm --dir packages/app exec tsc --noEmit
pnpm --dir packages/app exec vitest run
pnpm --dir packages/contracts exec hardhat test
```

## Risk review

- User-facing risk:
- Contract/storage risk:
- Ops/deployment risk:

## Public-truth check (required for marketing/docs changes)

- [ ] No mainnet readiness overclaim
- [ ] No claim of automatic digital delivery unless implemented
- [ ] Domains/canonicals use `*.myblank.app`
- [ ] Scope statements match `docs/LAUNCH_READINESS.md`

## Linked issues

Closes #
