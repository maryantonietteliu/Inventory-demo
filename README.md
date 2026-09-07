# Stockyard

A multi-warehouse inventory management system built end-to-end for a working hardware & construction supply business — replacing paper stock cards with a live, real-time system.

**Live demo:** [demostockyard.netlify.app](https://demostockyard.netlify.app/)

> This repo runs entirely on made-up sample data and a mocked backend — see [Note on this repo](#note-on-this-repo) below. No real business data, names, or credentials are included anywhere in this code.

## What it does

Stockyard gives every warehouse worker the same live view of stock, across warehouses and material categories, from any device.

- **Multi-warehouse tracking** — live stock levels, value, and reorder status per SKU, across warehouses and categories (roofing, metal, lumber, and more).
- **Fast stock in / out logging** — single-item and bulk entry modes, with keyboard- and tap-friendly workflows (including live item-name suggestions) for logging many line items quickly.
- **Partial-fulfillment tracking** — automatically flags when a customer order or supplier delivery is only partly completed, and records exactly when the remaining balance is claimed.
- **Printable PO summaries** — one-click PDF summaries per purchase order, with line items, quantities, cost totals, and fulfillment status.
- **Walk-in sales support** — a dedicated flow for cash customers with no PO, so the log stays complete without forcing paperwork that doesn't exist.
- **Reporting & exports** — CSV/PDF exports across inventory, transaction log, reorder report, dead stock, and unclaimed items.

## Why it mattered

The business could finally answer, at a glance: what's on hand, what's still owed to a customer, and what a supplier still owes back — questions that used to take a phone call and a stack of paper to answer.

## My role

I defined the requirements from real day-to-day warehouse operations, designed the data model and business rules, and directed the build using AI-assisted development — then iterated it against live use, fixing real workflow bugs (e.g. bulk-entry data loss on a fast Enter-key workflow, missing item-search suggestions on mobile) as they turned up.

## Built with

Firebase Firestore · Firebase Auth · JavaScript · Netlify

## Note on this repo

This code is a portfolio copy adapted from the real production system:

- The business name has been replaced with a fictional one ("Sample Hardware Co."), and every inventory item, customer, supplier, and transaction shown is made up.
- It does **not** connect to any real Firebase project. `demo-firebase-*.js` are small in-memory stand-ins for Firebase's Firestore/Auth/App SDKs, seeded with the fictional sample data in `demo-firebase-firestore.js` — the whole thing runs client-side with zero backend calls.
- Sign-in accepts any email/password combination, since there's no real account behind it.

## Running it locally

No build step or dependencies — it's a static site.

```
git clone <this-repo-url>
cd stockyard-demo-site
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a browser.
