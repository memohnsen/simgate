# simgate

One gate per machine for iOS simulators, Android emulators and Metro ports. Every
repository (Atlas, MeetCal, t3code) and every agent worktree on a machine goes through it,
so agents take turns instead of loading builds over each other, and two iOS agents can work
at once on separate simulators.

```sh
simgate run --platform ios --bundle-id com.example.app --record-build -- bunx expo run:ios --device {udid}
simgate run --platform android -- bunx expo run:android
simgate run --platform ios --no-metro -- xcodebuild test -destination id={udid} ...
simgate in-session -- maestro --device {udid} test .maestro
simgate status
```

## Rules

- **Two sessions per machine, each on its own device.** Slot 1 (Metro on 8081) takes any
  session; slot 2 (Metro on 8082) takes a second iOS session. A third session waits, printing
  who holds each slot and when their leases end, and starts by itself when one frees.
- **iOS: at most two, on distinct simulators.** An iOS session claims one simulator for its
  whole run. No two live sessions ever hold the same device. At most two iPhones (and two
  iPads) stay booted: a session reuses a booted device before it boots another.
- **Android: one at a time.** Android and web sessions take slot 1 only, so they never run
  beside each other. A second iOS session in slot 2 never competes for slot 1, so Android
  waits on exactly what it always waited on: the slot-1 holder.
- **Port 8081 is solved, not shared.** Each slot owns its port. The command gets it as
  `RCT_METRO_PORT` (which `expo start`, `expo run:ios` and React Native's native build all
  read) and as `{port}`. The slot-2 dev client is launched against 8082 by `expo run:ios`.
  A port held by a process outside simgate stops the session with its pid, command and
  directory; simgate never kills it.
- **Leases.** A session stops after 30 minutes (`--lease-min`, `SIMGATE_LEASE_MIN`), with a
  warning two minutes before, so a forgotten Metro cannot hold a slot forever (exit 124).
- **Cleanup.** However a session ends (exit, lease, `kill`, Ctrl-C, crash), simgate stops the
  command's whole process tree (so Metro frees the port), then shuts down every
  simulator booted while it ran, except one another live session claimed, and, in slot 1,
  every emulator. Devices booted before the session started are left alone.
- **One session per worktree.** A second `simgate run` from the same directory exits at once.

## Which simulator a session gets

A session only ever claims one of the four simulators kept in Device Hub on every Mac
(`KEPT_SIMULATOR_NAMES` in `src/devices.ts`):

| Kept simulator | Use |
| --- | --- |
| `iPhone 18 Pro Max` | an iPhone, by default or by name |
| `iPhone 16` | an iPhone, by default or by name |
| `iPhone Duo` | an iPhone, by default or by name: with three kept iPhones, two iOS sessions always find a free one |
| `iPad Pro 13-inch (M5)` | the iPad, by name only |

They are pinned by display name, since every Mac has its own UDIDs. A name matches whatever
its case, spacing, dashes or brackets (`iPad Pro (13-inch) (M5)`). When one name is on
several simulators (one per runtime), simgate uses the most recently used one and ignores
the rest. Every other simulator simctl lists is ignored too, booted or not: each simulator
used grows its own folder of builds and data, which is how a Mac fills up. simgate never
creates a simulator: a session picks among the kept iPhones the Mac has, and a request for
a kept simulator the Mac lacks fails, saying to add it in Device Hub.

An iOS session asks for a device with `--device <name or UDID>`, `SIMGATE_DEVICE`, or a
`--device` in its own command; with none it gets one of the kept iPhones. A request must
name a kept simulator, or give a kept simulator's UDID: anything else fails at once, listing
the four, rather than fall back to some other iPhone. Of the matching kept simulators no
other live session holds, it takes the first tier that has one, most recently used first:

1. a booted simulator with a **current build**: nothing to boot, nothing to build;
2. a shut-down simulator with a current build, if fewer than two of its family are booted;
3. any other booted simulator (no boot, but the command builds);
4. any other shut-down simulator, under the same cap (fresh boot and build: the fallback).

A named device may pass the cap, since the caller asked for it. A session plans its device
before it takes a slot: when every matching simulator is held by another session, it waits
without holding one, so it never keeps Android out of slot 1.

A build is **current** when the app (`--bundle-id`) installed on the simulator is the
install simgate recorded, and the native fingerprint recorded with it equals the checkout's.
`--record-build` records the install a build command makes: simgate watches the claimed
simulator and writes the record when a new install of the app appears (Expo keeps running
Metro after installing, so the install marks the build, not the exit). Records live in
`~/.cache/metro/simulator-builds/`, one per simulator and app; a reinstall by anyone else
changes the install and makes the record stale.

The fingerprint is Expo's (`node_modules/.bin/fingerprint fingerprint:generate --platform
ios`, the hash EAS uses for the runtime version) in an Expo project. It covers native code,
the app config and config plugins, native dependencies and `package.json` scripts (which can
run during a native build), not JavaScript, so any worktree whose native side matches can
use the build: Metro serves its JavaScript. A change to any of those needs one rebuild. A fingerprint Expo computed without
loading the app config is refused. Other projects pass `--fingerprint-command '<sh>'` that
prints one token (for example `git rev-parse HEAD:ios`); without either, there is no
current-build preference.

## In the command

- `{udid}` becomes the claimed simulator's UDID and `{port}` the slot's Metro port.
- Every `--device` flag becomes one `--device <udid>` (Expo and Maestro both take it). With
  no simulator (Android, or a machine without `simctl`), `--device {udid}` is dropped and a
  named device is left for the command; any other `{udid}` is an error.
- Environment: `SIMGATE_UDID`, `SIMGATE_PORT`, `SIMGATE_SLOT`, and `RCT_METRO_PORT`.
- `simgate in-session -- <command>` runs only while this worktree holds a session, aimed at
  that session's simulator and port, and takes no lock (Maestro against the loaded app).
- `--open-url <url>` opens the URL (with `{port}` filled) on the claimed simulator once Metro
  listens. Pass the Expo dev client URL on `start`: a reused build reopens the last server it
  loaded, which may be another slot's Metro, so the session points it at its own.
- `--no-metro` is for commands that drive a simulator without Metro (XCUITest, Maestro
  against an installed build, a bare boot): same slots, claim, lease and cleanup, no port check.

## Wiring a repository

A repository keeps only its rule in `AGENTS.md` and scripts that call `simgate`:

```jsonc
// Expo (Atlas, MeetCal): package.json
"start":   "simgate run --platform ios --bundle-id com.memohnsen.atlas --open-url 'exp+atlas://expo-development-client/?url=http%3A%2F%2Flocalhost%3A{port}' -- expo start",
"ios":     "simgate run --platform ios --bundle-id com.memohnsen.atlas --record-build -- bun run scripts/run-ios.ts --device {udid}",
"android": "simgate run --platform android -- expo run:android",
"sim:lock": "simgate run --platform ios --no-metro --bundle-id com.memohnsen.atlas --",
"test:e2e": "simgate in-session -- maestro --device {udid} test .maestro"
```

```sh
# A native Xcode project (t3code's iOS app): build, install and launch on the claimed simulator.
simgate run --platform ios --no-metro --bundle-id <bundle id> --record-build \
  --fingerprint-command 'git rev-parse HEAD:apps/ios' -- \
  sh -c 'xcodebuild -scheme App -destination id=$SIMGATE_UDID ... && xcrun simctl install $SIMGATE_UDID ...'
```

An iPad check: `SIMGATE_DEVICE="iPad Pro 13-inch (M5)" bun run ios` (or `-- --device "<name>"`,
with any of the four kept names).

## Compatibility

Slot 1 is `~/.cache/metro/simulator.lock` (`$XDG_CACHE_HOME/metro/` when set), the path
Atlas's and MeetCal's in-repo lock scripts used, with the same owner format. A checkout that
still runs those scripts takes slot 1 and queues with simgate's sessions. Because such a
holder does not record its simulator, simgate never runs a slot-2 session beside it. The one
gap is a session already running in slot 2 when an old checkout takes slot 1: the old
script picks any booted simulator, which can be slot 2's. It closes once every checkout on
the machine has the repository change that switches to simgate: rebase in-flight worktrees.

Slot 2 is `simulator-2.lock`, claims are `simulator-device-<UDID>.lock`, beside slot 1.
`SIMGATE_LOCK_PATH` moves slot 1 (tests); `SIMGATE_BASE_PORT` moves 8081 (tests).

## Install and update

Each machine that runs simulators or emulators (the MacBook, the Linux workstation) builds
simgate from its own checkout into one binary:

```sh
git clone git@github.com:memohnsen/simgate.git ~/dev/simgate
~/dev/simgate/install.sh          # builds ~/.local/bin/simgate; needs Bun (mise)
simgate version
```

`~/.local/bin` must be on `PATH` for every shell agents use (fish, zsh, `bash -lc`).
`simgate update` pulls the checkout (`--ff-only`) and rebuilds; a session already running
keeps its old binary until it ends. Off macOS there are no simulators, so every session is
slot 1's and simgate behaves as a single lock for the Android emulator.

## Develop

```sh
mise exec -- bun install
mise exec -- bun run check     # typecheck and tests
```
