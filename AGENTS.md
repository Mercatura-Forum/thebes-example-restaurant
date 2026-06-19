# AGENTS.md — deploying this example

A canonical, copy-pasteable contract for an automated agent deploying
`thebes-example-restaurant` to a Thebes cluster. Human-readable detail is in
[README.md](README.md).

## Layout

```
thebes.toml                 deploy manifest (network + canisters)
motoko/main.mo              backend (Motoko); imports mo:thebes-lib/{Admin,Invoices}
motoko/thebes-lib/          vendored backend library (local Mops dep — no external pin)
frontend/                   React + Vite app on @thebes/sdk
frontend/vendor/@thebes/sdk vendored SDK (local file: dep — no external pin)
```

## Toolchain (exact)

- Motoko compiler **1.4.1**, fetched by `mops install` to
  `~/.cache/mops/moc/1.4.1/moc` (macOS: `~/Library/Caches/mops/moc/1.4.1/moc`).
  Do **not** invoke a bare `moc` — a default `PATH` may resolve a different
  compiler version or Qt's Meta-Object Compiler.
- Node 18+, Mops, and the `thebes-deploy` CLI (Linux x86-64 prebuilt; build from
  the release source bundle on other platforms).
- `mops install` prints `core@2.5.0 requires moc >= 1.6.0` while 1.4.1 is pinned.
  This is expected — the cluster pins 1.4.1 and the build succeeds.

## Deploy

```sh
# 0. network: replace NODE_A..NODE_D in thebes.toml [networks.wan].validators
#    with the endpoints printed by:
thebes-deploy init                # prints current WAN cluster validators

# 1. backend
thebes-deploy identity new me
thebes-deploy deploy restaurant   # → prints the backend cid (call it RESTAURANT_CID)

# 2. frontend
curl -L -o asset_canister.wasm \
  https://github.com/Mercatura-Forum/Thebes-Protocol-/releases/download/asset-canister-v0.1.0/asset_canister.wasm
cd frontend && npm install && npm run build && cd ..
sed -i 's#<head>#<head><script>window.RESTAURANT_CID=RESTAURANT_CID;</script>#' frontend/dist/index.html
thebes-deploy deploy web          # → prints https://memphis.mercaturaforum.com/_/raw/<cid>/index.html
```

Verify: `curl -s -o /dev/null -w '%{http_code}' <printed-url>` returns `200`.

## Calling the backend

```sh
thebes-deploy query restaurant getMenu       # queries need no identity
thebes-deploy call  restaurant seedDemo       # updates need a local identity
```

Candid arguments use textual form via `--arg`, e.g.
`--arg '("Mezze platter", 850000000 : nat, null)'`. Positional bare arguments
are rejected — every argument tuple goes inside a single `--arg '(...)'`.

Public methods on `main.mo`:

- **Queries (no identity):** `getOwner`, `getAdmins`, `isPaused`, `getMenu`,
  `getMenuItem`, `getOrder`, `getOpenOrders`, `menuView`.
- **Caller-scoped queries:** `getOwnerStats`, `myOrdersView`, `myInvoicesView`,
  `kitchenView`.
- **Updates (local identity required):** `claimOwner`, `transferOwner`,
  `addAdmin`, `removeAdmin`, `setPaused`, `addMenuItem`/`addMenuItemOrTrap`,
  `setMenuItemPhoto`/`setMenuItemPhotoOrTrap`, `setItemAvailable`/`setItemAvailableOrTrap`,
  `updateMenuPrice`, `placeOrder`/`placeOrderFlatOrTrap`,
  `startPreparingOrder`/`startPreparingOrderOrTrap`,
  `markOrderReady`/`markOrderReadyOrTrap`, `markDelivered`/`markDeliveredOrTrap`,
  `seedDemo`.

## Conventions that affect correctness

- **`window.RESTAURANT_CID`** (and optional `window.MEDIA_CID`) are injected into
  the built page at deploy time; the frontend reads them at runtime. If you skip
  the injection step, the page falls back to compiled-in defaults and talks to the
  wrong backend.
- **`*OrTrap` methods** (e.g. `placeOrderFlatOrTrap`, `markOrderReadyOrTrap`) trap
  on a failed guard so the client sees a rejection instead of a silently-swallowed
  error. Frontends call the `OrTrap` form for any guarded write.
- **Boundary decoding** returns a `vec record` of scalar fields. A single record is
  a 0-or-1-element array; principal fields are 56-character hex. Decode with the
  SDK's `decodeVecRecord` / `decodeNat` / `decodeBool`.
