# Restaurant Billing & Management System

A compact local restaurant operations app for managing a menu, recording dine-in and takeaway orders, tracking order/payment status, and printing itemized receipts.

## Features

- Dashboard totals from persisted orders and payments
- Menu creation/editing, search, category and availability filters
- Order cart with quantities and server-validated item availability
- Server-calculated bills in integer paise, with historical item name/price snapshots
- Order history and detail/receipt reopening
- Order lifecycle: Pending → Preparing → Ready → Completed; active states may be cancelled
- One-time Cash, UPI, or Card payment recording
- Print stylesheet for clean receipt printing

## Stack and structure

- Node.js built-in HTTP server and `node:sqlite` (SQLite)
- Vanilla JavaScript, HTML, and CSS frontend; no third-party runtime packages
- `server.js`: HTTP routing, API responses, and static server
- `lib/database.js`: SQLite configuration, schema, transactions, and read models
- `lib/domain.js`: menu validation and transactional order/billing logic
- `public/`: interface
- `test/app.test.js`: isolated API integration tests
- `scripts/init-db.js`: explicit schema setup
- `docs/ASSESSMENT_AUDIT.md`: requirement matrix, verification evidence, and open items

Node.js 22.13 or newer is required for the built-in SQLite module. Node may show an experimental-module warning for `node:sqlite`. No account or credentials are required. This local assessment app is intended for a trusted development/demo environment.

## Setup (Windows PowerShell)

```powershell
Copy-Item .env.example .env
npm.cmd run db:init
npm.cmd start
```

Then open [http://localhost:3000](http://localhost:3000). The database is created at `.data/restaurant.sqlite` and persists between server restarts. Startup creates missing tables and indexes without dropping existing data. `npm.cmd run db:init` uses the same configured database path.

The server reads `.env` on startup; values already set in the shell take precedence. By default it binds to `127.0.0.1`, so the unauthenticated demo server is local to this machine. You can also set values directly in PowerShell:

```powershell
$env:PORT = "3000"
$env:HOST = "127.0.0.1"
$env:DB_PATH = ".data/restaurant.sqlite"
$env:RESTAURANT_NAME = "The Green Fork"
$env:RESTAURANT_PHONE = ""
$env:TAX_RATE_BPS = "0"
npm.cmd start
```

`TAX_RATE_BPS` is an optional basis-points rate, defaulting to zero; for example `825` means 8.25%. This is a configurable demo calculation, not a statement of applicable tax law. Tax is rounded to the nearest paise per order. No demo data is seeded, so dashboard counts begin at zero. Create menu items in Menu management before placing an order.

The checked-out workspace currently contains one manually created sample item (`Masala Dosa`) and two demo orders for demonstration; a fresh database starts empty. Tests use separate temporary databases.

## API

The frontend and API share the same origin, so no cross-origin API access is enabled. Main endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/config` | Restaurant display and tax settings |
| GET | `/api/dashboard` | Persisted operational totals |
| GET | `/api/menu?q=&category=&available=` | Menu listing and filters |
| POST | `/api/menu` | Create menu item |
| PUT | `/api/menu/:id` | Update menu item |
| POST | `/api/orders` | Create order and immutable line snapshots; requires an `Idempotency-Key` header |
| GET | `/api/orders?q=&limit=` | Search recent orders (limit capped at 100) |
| GET | `/api/orders/:id` | Order and receipt details |
| PATCH | `/api/orders/:id/status` | Enforce allowed status transition |
| POST | `/api/orders/:id/payment` | Record one full payment |

Example order body:

```json
{"order_type":"Dine in","table_number":"4","customer_name":"Asha","items":[{"menu_item_id":1,"quantity":2}]}
```

Include a unique client-generated key, such as `Idempotency-Key: 2c24b55a-f5bd-4747-a745-8d3fe141a62a`, when creating an order. Repeating the same request with the same key returns the original order; reusing the key for different order details returns HTTP 409.

The server always obtains current prices from SQLite. Monetary API fields ending in `_paise` are integer paise (₹1 = 100 paise). Historical bills use stored snapshots and are not recalculated from later menu changes. Orders, their items, and the idempotency record are saved in one transaction. Payment is full-amount and can be recorded once.

## Tests and production use

```powershell
npm.cmd test
```

Tests start the server against a fresh temporary SQLite database and remove it afterward; they do not touch the development database. This project has no separate frontend bundle/build step: the browser loads static assets directly from the Node server.

## Known limitations and future improvements

- No authentication, roles, remote deployment, or payment gateway; do not expose this local demo server to an untrusted network.
- No inventory, discounts, partial payments, or data export.
- Dashboard “sales today” counts paid orders by UTC database date; the operating timezone is not configurable.
- Add a migration versioning process before schema evolution in production.
- Browser verification covered the desktop layout and interactive order-to-receipt workflow; mobile viewport and browser console inspection were unavailable in the provided browser controls.
- The print stylesheet was reviewed in source, but the browser print preview and a physical printer were not verified.
- Future work could include staff authentication, timezone-aware reporting, inventory tracking, and receipt printer integration.

## GitHub repository

The project source is published at [singhvijayarya/restaurant-billing-management-system](https://github.com/singhvijayarya/restaurant-billing-management-system). `.data/`, `.env`, SQLite database files, and the generated source archive are excluded from Git; the archive excludes the local database, `.env`, and Git metadata.
