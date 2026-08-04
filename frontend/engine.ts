import { CollectionInfo, RuleMap } from './types';

/**
 * Steam locks every method on a collection's filter object down as a
 * non-writable, non-configurable own property, so neither prototype patching
 * nor a Proxy can intercept `Matches`. The one seam MobX leaves open is that
 * `m_filter` itself is an accessor *with a setter*.
 *
 * So we swap in a stand-in object that inherits the same prototype, forwards
 * every own property (including the MobX administration symbols) back to the
 * original, and overrides only `Matches` and `bIsEmpty`. Steam's own
 * `UpdateApps` then calls our `Matches` without knowing the difference, and the
 * cloud-synced `filterSpec` is never touched.
 */

const WRAPPED_FLAG = '__collectionFilterWrapper';

/** How often the source collections are re-checked for membership changes. */
const WATCH_INTERVAL_MS = 3000;

interface WrapEntry {
	origFilter: any;
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) if (!b.has(value)) return false;
	return true;
}

function getStore(): any {
	return (window as any).collectionStore;
}

/**
 * Steam's collection getters are MobX computeds that throw outright before the
 * store is populated. An escaping exception poisons the surrounding computation
 * and can tear down the library UI, so every read is guarded.
 */
function safeRead<T>(read: () => T, fallback: T): T {
	try {
		const value = read();
		return value === undefined || value === null ? fallback : value;
	} catch {
		return fallback;
	}
}

function getAppPool(): any[] {
	return safeRead(() => getStore()?.allAppsCollection?.allApps as any[], []);
}

export function listCollections(): CollectionInfo[] {
	const collections = safeRead(() => getStore()?.userCollections as any[], []);
	if (!Array.isArray(collections)) return [];
	return collections.map((c: any) => ({
		id: c.id,
		name: c.displayName,
		isDynamic: !!c.bIsDynamic,
	}));
}

export class FilterEngine {
	private wrapped = new Map<string, WrapEntry>();
	private sourceSets = new Map<string, Set<number>>();
	private rules: RuleMap = {};
	private watchTimer: ReturnType<typeof setInterval> | null = null;

	/** Union of the app ids held by every source collection of a rule. */
	private buildSet(targetId: string): Set<number> {
		const store = getStore();
		const rule = this.rules[targetId];
		const set = new Set<number>();
		if (!store || !rule) return set;

		for (const sourceId of rule.sourceIds) {
			// `apps` holds bare app ids, whereas `allApps` maps every id to an
			// overview and sorts the result. Since this runs on a timer, take the
			// cheap one whenever it is available.
			const ids = safeRead(() => store.GetCollection(sourceId)?.apps as any, null);
			if (ids && typeof ids.values === 'function') {
				for (const value of ids.values()) {
					const appid = typeof value === 'number' ? value : value?.appid;
					if (typeof appid === 'number') set.add(appid);
				}
				continue;
			}
			const apps = safeRead(() => store.GetCollection(sourceId)?.allApps as any[], []);
			if (Array.isArray(apps)) for (const app of apps) set.add(app.appid);
		}
		return set;
	}

	/**
	 * Rebuilds every cached set. Never called from inside `Matches`: reading a
	 * source collection can itself trigger an `UpdateApps` pass, and rebuilding
	 * mid-pass would recurse.
	 */
	private rebuildSets(): void {
		for (const targetId of Object.keys(this.rules)) {
			this.sourceSets.set(targetId, this.buildSet(targetId));
		}
	}

	/**
	 * Steam only re-evaluates a collection when something about *it* changes, so
	 * adding a game to a source collection would otherwise leave the filtered
	 * collection stale until a UI reload. Poll the sources and refresh on change.
	 */
	private syncIfChanged(): void {
		for (const targetId of Object.keys(this.rules)) {
			if (!this.wrapped.has(targetId)) continue;
			try {
				const next = this.buildSet(targetId);
				const previous = this.sourceSets.get(targetId);
				if (previous && setsEqual(previous, next)) continue;
				this.sourceSets.set(targetId, next);
				this.refresh(targetId);
			} catch (error) {
				console.error(`[Exclude collections] Sync failed for ${targetId}:`, error);
			}
		}
	}

	private startWatching(): void {
		if (this.watchTimer !== null) return;
		this.watchTimer = setInterval(() => this.syncIfChanged(), WATCH_INTERVAL_MS);
	}

	private stopWatching(): void {
		if (this.watchTimer === null) return;
		clearInterval(this.watchTimer);
		this.watchTimer = null;
	}

	private buildWrapper(targetId: string, origFilter: any): any {
		const wrapper = Object.create(Object.getPrototypeOf(origFilter));

		for (const key of Reflect.ownKeys(origFilter)) {
			if (key === 'Matches') continue;
			Object.defineProperty(wrapper, key, {
				get: () => origFilter[key],
				set: (value: any) => {
					origFilter[key] = value;
				},
				configurable: true,
				enumerable: true,
			});
		}

		Object.defineProperty(wrapper, 'Matches', {
			value: (app: any) => {
				if (!origFilter.Matches(app)) return false;
				const rule = this.rules[targetId];
				const set = this.sourceSets.get(targetId);
				if (!rule || !set) return true;
				return rule.mode === 'exclude' ? !set.has(app.appid) : set.has(app.appid);
			},
			configurable: true,
			enumerable: true,
		});

		// Steam skips filtering entirely when the native filter is empty, which
		// would bypass our rule on an otherwise-unfiltered collection.
		Object.defineProperty(wrapper, 'bIsEmpty', { get: () => false, configurable: true });
		Object.defineProperty(wrapper, WRAPPED_FLAG, { value: true, configurable: true });

		return wrapper;
	}

	private wrap(targetId: string): void {
		if (this.wrapped.has(targetId)) return;
		try {
			const collection = getStore()?.GetCollection(targetId);
			if (!collection) return;

			const origFilter = collection.m_filter;
			if (!origFilter || origFilter[WRAPPED_FLAG]) return;

			collection.m_filter = this.buildWrapper(targetId, origFilter);
			if (collection.m_filter !== origFilter) {
				this.wrapped.set(targetId, { origFilter });
			}
		} catch (error) {
			console.error(`[Exclude collections] Could not wrap ${targetId}:`, error);
		}
	}

	private unwrap(targetId: string): void {
		const entry = this.wrapped.get(targetId);
		if (!entry) return;
		try {
			const collection = getStore()?.GetCollection(targetId);
			if (collection) collection.m_filter = entry.origFilter;
		} catch (error) {
			console.error(`[Exclude collections] Could not unwrap ${targetId}:`, error);
		}
		this.wrapped.delete(targetId);
		this.sourceSets.delete(targetId);
	}

	private refresh(targetId: string): void {
		const collection = getStore()?.GetCollection(targetId);
		if (!collection) return;
		try {
			collection.UpdateApps(getAppPool(), []);
		} catch (error) {
			console.error(`[Exclude collections] Refresh failed for ${targetId}:`, error);
		}
	}

	/** Installs the given rules, removing any wrapper that is no longer needed. */
	applyRules(rules: RuleMap): void {
		this.rules = rules;

		for (const targetId of Array.from(this.wrapped.keys())) {
			const rule = rules[targetId];
			if (!rule || rule.sourceIds.length === 0) {
				this.unwrap(targetId);
				this.refresh(targetId);
			}
		}

		this.rebuildSets();

		for (const [targetId, rule] of Object.entries(rules)) {
			if (!rule || rule.sourceIds.length === 0) continue;
			this.wrap(targetId);
			this.refresh(targetId);
		}

		if (this.wrapped.size > 0) this.startWatching();
		else this.stopWatching();
	}

	/** Restores every collection to its untouched state. */
	teardown(): void {
		this.stopWatching();
		for (const targetId of Array.from(this.wrapped.keys())) {
			this.unwrap(targetId);
			this.refresh(targetId);
		}
		this.rules = {};
	}
}
