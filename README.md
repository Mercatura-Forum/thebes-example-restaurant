# thebes-example-restaurant

An on-chain restaurant built on [Thebes Protocol](https://github.com/Mercatura-Forum/Thebes-Protocol-):
a Motoko backend that holds the menu, customer orders, and per-order invoices,
and a React frontend served as certified assets. It demonstrates the full shape
of a Thebes application — passkey sign-in, controller-gated admin, a live kitchen
view, and threshold-signed on-chain state — in one self-contained example.

## Architecture

```
frontend (React + Vite + Tailwind)   →   restaurant backend (Motoko)
   @thebes/sdk  ── boundary client       mo:thebes-lib ── Admin / Invoices
   Memphis passkey gate                  menu · orders · kitchen
```

- **frontend/** uses `@thebes/sdk` for the boundary client, typed query/update
  calls, React hooks, and the Memphis passkey gate. The SDK is **vendored** under
  `frontend/vendor/@thebes/sdk` and resolved as a local dependency
  (upstream source of truth: [`thebes-sdk`](https://github.com/Mercatura-Forum/thebes-sdk)).
- **motoko/** uses `thebes-lib` for `Admin` (controller-gated operations) and
  `Invoices` (per-order billing); the restaurant logic lives in `main.mo`. The
  library is **vendored** under `motoko/thebes-lib` and resolved as a local Mops
  dependency.

Both halves are self-contained: the repository builds with no external Git or Mops
toolkit pins. The frontend asset-canister wasm is the one artifact fetched at
deploy time (see [Deploy](#deploy)).

## Backend interface (selected)

| Method | Kind | Purpose |
| --- | --- | --- |
| `getMenu` / `menuView` | query | Browse the menu. |
| `seedDemo` | update | Populate a demo menu (admin). |
| `addMenuItem` / `updateMenuPrice` / `setItemAvailable` / `setMenuItemPhoto` | update | Menu management (admin). |
| `placeOrderFlatOrTrap` | update | Place an order; traps on any guard failure so the client never silently ignores an error. An invoice is issued per order. |
| `myOrdersView` / `myInvoicesView` | query | The caller's orders and invoices. |
| `kitchenView` / `getOpenOrders` | query | Live kitchen queue. |
| `startPreparingOrder` / `markOrderReady` / `markDelivered` | update | Advance an order through its lifecycle (admin). |
| `claimOwner` / `addAdmin` / `setPaused` | update | Ownership and admin surface (from `thebes-lib`'s `Admin`). |

The token uses 8 decimals (e8s); prices are stored and returned in base units.

## Toolchain

- **Motoko compiler 1.4.1.** `mops install` fetches the pinned compiler to
  `~/.cache/mops/moc/1.4.1/moc` (macOS: `~/Library/Caches/mops/moc/1.4.1/moc`).
  Use that binary — the `moc` on a default `PATH` may be a different version, or
  Qt's unrelated Meta-Object Compiler.
- **Node 18+** and **[Mops](https://mops.one)** for the two builds.
- **[`thebes-deploy`](https://github.com/Mercatura-Forum/Thebes-Protocol-/releases)**
  to deploy. The prebuilt binary is Linux x86-64; on other platforms build it from
  the release source bundle (`cargo build --release -p thebes-deploy`).

## Run locally

```sh
# Frontend
cd frontend
npm install            # resolves the vendored @thebes/sdk
npm run dev            # sync-sdk copies the browser runtimes into public/, then Vite serves

# Backend (compile-check)
cd ../motoko
mops install           # resolves the vendored thebes-lib + the pinned compiler
"$(ls "$HOME/.cache/mops/moc/1.4.1/moc" "$HOME/Library/Caches/mops/moc/1.4.1/moc" 2>/dev/null | head -1)" --check $(mops sources) main.mo
```

## Deploy

`thebes.toml` describes the deploy. It ships with the current WAN cluster
validators pre-filled — run `thebes-deploy init` to refresh them with the
endpoints the CLI prints for the live cluster.

> **Deploying your own copy?** The committed `cid` values pin the **live catalog
> deployment** (that's what the demo links serve — only its controller can
> upgrade it). Before your first deploy, set `cid = "auto"` on each canister:
> the deploy allocates fresh canisters you control and writes their ids back
> into the manifest.

### 1. Backend

```sh
thebes-deploy identity new me        # one-time local signing identity
thebes-deploy deploy restaurant      # build + install + verify → prints the backend cid
```

### 2. Frontend

The frontend installs an asset canister, then uploads your built bundle. Fetch the
asset-canister wasm once (it is referenced by `thebes.toml` as `asset_canister.wasm`):

```sh
curl -L -o asset_canister.wasm \
  https://github.com/Mercatura-Forum/Thebes-Protocol-/releases/download/asset-canister-v0.1.0/asset_canister.wasm
```

Build the bundle and point it at your backend cid (the frontend reads
`window.RESTAURANT_CID` at runtime), then deploy:

```sh
cd frontend && npm run build && cd ..
# inject the backend cid from step 1 into the built page:
sed -i 's#<head>#<head><script>window.RESTAURANT_CID=YOUR_RESTAURANT_CID;</script>#' frontend/dist/index.html
thebes-deploy deploy web             # install asset canister + upload bundle + verify
```

The deploy prints the live URL:
`https://memphis.mercaturaforum.com/_/raw/<web-cid>/index.html`.

> Menu-item photos are served by a separate media canister via `window.MEDIA_CID`.
> It is optional — without one, items render without images.

For a machine-readable deploy contract, see [AGENTS.md](AGENTS.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
