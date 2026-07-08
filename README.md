# thebes-example-restaurant

An on-chain restaurant built on [Thebes Protocol](https://github.com/Mercatura-Forum/Thebes-Protocol-):
a Motoko backend that holds the menu, the dining-room floor, reservations,
orders and invoices, and a React frontend whose home page **is the live floor**
— every table drawn from chain state, arrangeable by the kitchen on a real
floor plan.

The property this example proves is **single allocation under time**. A dining
table is scarce in two dimensions — right now (one active order at a time) and
across time (no two overlapping reservations) — and, on the plan, in space (no
two tables on the same cells). Every booking, seating and placement is validated
on-chain, and the public oracle (`invariantReportView` / `floorSealView`)
recomputes all the allocation laws on demand; an empty report is the proof the
floor can never be double-allocated.

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
| `getMenu` / `menuView` | query | Browse the menu (photos live in the media contract; the app stores pointers). |
| `seedDemo` | update | Populate a demo menu **and floor** — six numbered tables. |
| `addMenuItem` / `updateMenuPrice` / `setItemAvailable` / `setMenuItemPhoto` | update | Menu management (kitchen). |
| `addTable` / `setTableSeats` / `retireTable` / `setTablePosition` | update | The floor: numbered tables, resize, retire-when-free, and grid placement with the no-overlap guard. |
| `reserveTableOrTrap` / `cancelReservation` / `seatReservation` / `completeReservation` | update | Reservations — overlapping windows are rejected on-chain; the kitchen seats, closes and no-shows parties. |
| `placeOrderFlatOrTrap` / `moveOrderToTable` | update | Orders (table 0 = take-away); a dine-in order claims its table — one active order per table. An invoice is issued per order. |
| `floorView` | query | The whole floor in one call: derived table status, current order, covering reservation, next booking, grid position. |
| `myOrdersView` / `myReservationsView` / `myInvoicesView` | query | The caller's orders, bookings and invoices. |
| `kitchenView` / `reservationsBookView` / `floorEventsView` | query | Kitchen queue, the reservation book, the floor's story. |
| `startPreparingOrder` / `markOrderReady` / `markDelivered` | update | Advance an order; delivery frees its table (kitchen). |
| `invariantReportView` / `floorSealView` | query | **The public oracle** — one order per table, zero overlapping bookings, party fits, no floor overlaps. |
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
