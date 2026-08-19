# Exclude collections in collection

A [Millennium](https://steambrew.app/) plugin that filters a Steam dynamic collection by the contents of your other collections — either excluding games that belong to them, or keeping only games that do.

Steam's dynamic collections can filter on tags, features, platforms and so on, but not on collection membership. This fills that gap: you can have an "In progress" collection that automatically drops everything already sitting in "Completed".

## Features

- **Exclude mode** — hide games that belong to the selected collections
- **Include mode** — keep only games that belong to the selected collections
- Set directly **inside Steam's own filter editor**, alongside the native filters
- Also available while **creating** a new dynamic collection
- Rules are set **per dynamic collection**, and stack on top of Steam's own filters
- Settings persist across restarts
- Filtered collections update on their own when the source collections change

## Installing

Copy this folder into your Millennium `plugins/` directory (e.g. `…\Steam\millennium\plugins\exclude-collections-in-collection\`) and restart Steam, then enable it in Millennium's settings.

Only the following are needed at runtime:

```
exclude-collections-in-collection/
├── plugin.json
└── .millennium/Dist/index.js
```

## Usage

Open a dynamic collection's filter editor in your library — or start creating a new dynamic collection. Two extra buckets appear next to Steam's own, **Exclude collections** and **Include collections**. Pick collections from the dropdown; click a chip to remove it. Changes apply immediately, and a collection already used by one bucket is greyed out in the other.

The same rules can also be edited from **Exclude collections in collection** in the Millennium Library Manager, which additionally lists every rule you have set.

Only dynamic collections can be targeted. A static collection has no filter of its own, so pushing it through the filtering path would discard the membership you curated by hand.

## Building

```bash
npm install
npm run build
```

The bundle is written to `.millennium/Dist/index.js` by Millennium's compiler (`@steambrew/ttc`). It is not tracked in git — the plugin store builds the plugin itself and packages the result — so build locally before copying the plugin into your Millennium plugins folder to test.

## How it works

Steam evaluates a dynamic collection by calling `Matches()` on the collection's filter for every app. That method cannot be intercepted: MobX defines it as a non-writable, non-configurable *own* property, so prototype patching is shadowed, direct assignment is silently ignored, and a `Proxy` violates a language invariant on frozen properties.

The one seam MobX leaves open is that `m_filter` itself is an accessor **with a setter**. So `frontend/engine.ts` swaps in a stand-in object that inherits the same prototype, forwards every own property — MobX administration symbols included — back to the original, and overrides only `Matches` and `bIsEmpty`. Steam's own code calls it without noticing, and the cloud-synced `filterSpec` is never modified.

Three constraints worth knowing before changing this code:

- **Never read `userCollections` or `allAppsCollection` before Steam is ready.** They are MobX computeds that throw when the store is still empty, and MobX caches that error — Steam's own render then reads the cached failure and the library never draws. A `try/catch` does not help; the damage is done by the read itself. Startup gates on plain, non-derived fields instead.
- **Source collections are polled, not observed.** A reaction would be more elegant, but re-entering the MobX graph is the thing that broke the library repeatedly during development. A 3-second poll comparing app-id sets is the deliberate trade.
- **A wrapper cannot be assumed to stay installed.** Steam rebuilds `m_filter` when a collection is edited and saved, and again while it finishes its own start-up. That silently discards the stand-in, so each poll re-checks and reinstalls rather than trusting its bookkeeping.

### The injected UI

`frontend/nativeUi.tsx` appends buckets next to Steam's filter area; it never modifies Steam's own elements, so removing the plugin leaves the panel exactly as it was. Two details are load-bearing:

- **The buckets go beside the filter grid, not inside it.** That grid is declared `grid-template-rows: 2fr 1fr` and Steam's own buckets occupy the `2fr` row, so anything appended lands in the `1fr` row and every pixel of height it needs costs three — the native row is forced to twice ours. Steam hits the same problem with its own Language and Genre buckets and solves it by putting them in a sibling container, outside the grid; reusing that container's class puts ours in the same place and inherits its breakpoints.
- **The chip container carries a definite `width: 0` plus `min-width: 100%`.** Its width would otherwise be set by max-content, which for a wrapping row is every chip on a single line. A definite width contributes nothing to that measurement, and the `min-width` fills the available space once it has been resolved.
