# Changesets

Every change a user would notice gets a changeset: `pnpm changeset`, pick the
packages and the bump, describe it for the changelog. `pnpm changeset version`
turns them into version bumps and CHANGELOG entries.

The packages are one fixed group: they always share a version and are released
together, which is what lets them depend on each other's exact version.

The repository is in prerelease mode (`pre.json`, tag `beta`): `pnpm changeset
version` makes `1.0.0-beta.N` versions until `pnpm changeset pre exit` ends it.
