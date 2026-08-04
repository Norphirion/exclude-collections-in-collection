# Exclude collections in collection

A [Millennium](https://steambrew.app/) plugin that filters a Steam dynamic collection by the contents of your other collections — either excluding games that belong to them, or keeping only games that do.

Steam's dynamic collections can filter on tags, features, platforms and so on, but not on collection membership. This fills that gap: you can have an "In progress" collection that automatically drops everything already sitting in "Completed".

## Features

- **Exclude mode** — hide games that belong to the selected collections
- **Include mode** — keep only games that belong to the selected collections
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

Open **Exclude collections in collection** in the Millennium Library Manager:

1. Pick the dynamic collection you want to filter
2. Choose exclude or include
3. Toggle the collections to use as the source

Only dynamic collections can be targeted. A static collection has no filter of its own, so pushing it through the filtering path would discard the membership you curated by hand.

## Building

```bash
npm install
npm run build
```

The bundle is written to `.millennium/Dist/index.js` by Millennium's compiler (`@steambrew/ttc`). Copy it into your Millennium plugins folder to test.

## How it works

Steam evaluates a dynamic collection by calling `Matches()` on the collection's filter for every app. That method cannot be intercepted: MobX defines it as a non-writable, non-configurable *own* property, so prototype patching is shadowed, direct assignment is silently ignored, and a `Proxy` violates a language invariant on frozen properties.

The one seam MobX leaves open is that `m_filter` itself is an accessor **with a setter**. So `frontend/engine.ts` swaps in a stand-in object that inherits the same prototype, forwards every own property — MobX administration symbols included — back to the original, and overrides only `Matches` and `bIsEmpty`. Steam's own code calls it without noticing, and the cloud-synced `filterSpec` is never modified.

Two constraints worth knowing before changing this code:

- **Never read `userCollections` or `allAppsCollection` before Steam is ready.** They are MobX computeds that throw when the store is still empty, and MobX caches that error — Steam's own render then reads the cached failure and the library never draws. A `try/catch` does not help; the damage is done by the read itself. Startup gates on plain, non-derived fields instead.
- **Source collections are polled, not observed.** A reaction would be more elegant, but re-entering the MobX graph is the thing that broke the library repeatedly during development. A 3-second poll comparing app-id sets is the deliberate trade.

## License

MIT
