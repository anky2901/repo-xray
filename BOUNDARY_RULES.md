# Boundary Rules

Allowed dependency direction:

`apps -> sdk -> packages -> shared`

Forbidden dependency direction:

- `packages -> apps`
- `packages -> sdk`
- `shared -> packages`
- `shared -> sdk`
- `shared -> apps`
- `apps -> packages`
- `apps -> shared`

Enforcement:

- ESLint `no-restricted-imports` rules fail during `pnpm lint`
- Root `pnpm build` runs `pnpm lint` first
- Boundary tests verify both package manifests and source imports
