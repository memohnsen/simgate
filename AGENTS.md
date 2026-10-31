# simgate

A machine-wide gate for iOS simulators, Android emulators and Metro ports, shared by every
repository and agent on a machine. README.md explains the design; this file is for changing it.

- Bun only (version pinned in `mise.toml`); run commands through `mise exec --`.
- Verify with `mise exec -- bun run check` (typecheck and tests) before every commit.
- Tests never claim or boot a real simulator: CLI tests run Android sessions; slots and
  device planning are tested with injected listings.
- The lock paths, the owner file format and the slot-1 port are a protocol other checkouts
  read (see README, "Compatibility"). Change them only with a migration for every repository
  that wires in simgate.
- After changing the CLI, update the usage text in `src/cli.ts` and README together.
- iOS sessions claim only the four simulators kept in Device Hub, `KEPT_SIMULATOR_NAMES` in
  `src/devices.ts`, pinned by display name (never a UDID: each Mac has its own). A request
  outside them fails; simgate never boots another simulator, falls back to one, or runs
  `simctl create`. Changing the list changes every Mac: update README's table with it.
