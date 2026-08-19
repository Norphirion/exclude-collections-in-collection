import { IconsModule, definePlugin, Field, DialogButton, DropdownItem, ToggleField } from '@steambrew/client';
import { useState, useEffect, useMemo } from 'react';
import { FilterEngine, listCollections } from './engine';
import { loadRules, saveRules } from './storage';
import { CollectionInfo, FilterMode, RuleMap } from './types';
import { startNativeUi, stopNativeUi } from './nativeUi';

const engine = new FilterEngine();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Readiness probing has to avoid MobX *computeds* entirely.
 *
 * `userCollections` and `allAppsCollection` are computeds. Evaluating one before
 * Steam has populated the store throws — and MobX caches that error, so Steam's
 * own render later reads the cached failure and the library never draws. A
 * try/catch does not help: the damage is done by the read itself, not by the
 * exception escaping.
 *
 * These two signals are safe to poll: `MainWindowBrowserManager` is a plain
 * global, and `m_mapCollectionsFromStorage` is a stored field rather than a
 * derived one, so reading it computes nothing and caches nothing.
 */
function plainSignalsReady(): boolean {
	try {
		if (typeof (window as any).MainWindowBrowserManager === 'undefined') return false;
		const map = (window as any).collectionStore?.m_mapCollectionsFromStorage;
		return !!map && typeof map.size === 'number' && map.size > 0;
	} catch {
		return false;
	}
}

/** Only ever called once the plain signals above are up. */
function computedsUsable(): boolean {
	try {
		const store = (window as any).collectionStore;
		const collections = store?.userCollections;
		if (!Array.isArray(collections) || collections.length === 0) return false;
		const pool = store?.allAppsCollection?.allApps;
		return Array.isArray(pool) && pool.length > 0;
	} catch {
		return false;
	}
}

/**
 * `fast` skips the boot-time caution. The settings panel only ever renders after
 * the user has navigated Steam's UI, so the store is long since up by then and
 * making them wait five seconds to see their own collections is pointless.
 */
async function waitForStore(timeoutMs = 180000, fast = false): Promise<boolean> {
	const start = Date.now();

	if (fast && plainSignalsReady() && computedsUsable()) return true;

	while (Date.now() - start < timeoutMs) {
		if (plainSignalsReady()) break;
		await sleep(500);
	}
	if (!plainSignalsReady()) return false;

	// The collection map exists, but Steam is still wiring up the app store.
	await sleep(5000);

	while (Date.now() - start < timeoutMs) {
		if (computedsUsable()) return true;
		// Back off hard between attempts: an early computed read is not free, so
		// retrying tightly would be the very thing that breaks the library.
		await sleep(10000);
	}
	return false;
}

const SettingsContent = () => {
	const [rules, setRules] = useState<RuleMap>({});
	const [collections, setCollections] = useState<CollectionInfo[]>([]);
	const [targetId, setTargetId] = useState<string>('');
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		setRules(loadRules());
		let cancelled = false;
		(async () => {
			await waitForStore(180000, true);
			if (cancelled) return;
			setCollections(listCollections());
			setLoading(false);
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Only dynamic collections are safe targets: a static collection has an empty
	// native filter, and forcing it through the filter path would discard the
	// membership the user curated by hand.
	const targets = useMemo(() => collections.filter((c) => c.isDynamic), [collections]);
	const sources = collections;

	useEffect(() => {
		if (!targetId && targets.length > 0) setTargetId(targets[0].id);
	}, [targets, targetId]);

	const currentRule = rules[targetId] ?? { mode: 'exclude' as FilterMode, sourceIds: [] };

	const commit = (next: RuleMap) => {
		setRules(next);
		saveRules(next);
		engine.applyRules(next);
	};

	const setMode = (mode: FilterMode) => {
		commit({ ...rules, [targetId]: { ...currentRule, mode } });
	};

	const toggleSource = (sourceId: string) => {
		const sourceIds = currentRule.sourceIds.includes(sourceId)
			? currentRule.sourceIds.filter((id) => id !== sourceId)
			: [...currentRule.sourceIds, sourceId];
		commit({ ...rules, [targetId]: { ...currentRule, sourceIds } });
	};

	const clearRule = () => {
		const next = { ...rules };
		delete next[targetId];
		commit(next);
	};

	if (loading) {
		return <Field label="Loading collections…" description="Waiting for Steam's collection store" bottomSeparator="none" />;
	}

	if (targets.length === 0) {
		return <Field label="No dynamic collections found" description="Create a dynamic collection in your library first." bottomSeparator="none" />;
	}

	return (
		<>
			<Field
				label="Collection to filter"
				description="Rules apply to one dynamic collection at a time"
				icon={<IconsModule.Settings />}
				bottomSeparator="standard"
			>
				<DropdownItem
					rgOptions={targets.map((c) => ({ label: c.name, data: c.id }))}
					selectedOption={targetId}
					onChange={(option: any) => setTargetId(option.data)}
				/>
			</Field>

			<Field label="Mode" description="How the collections selected below are applied" bottomSeparator="standard">
				<DropdownItem
					rgOptions={[
						{ label: 'Exclude games from these collections', data: 'exclude' },
						{ label: 'Include only games from these collections', data: 'include' },
					]}
					selectedOption={currentRule.mode}
					onChange={(option: any) => setMode(option.data)}
				/>
			</Field>

			{sources
				.filter((c) => c.id !== targetId)
				.map((c) => (
					<Field key={c.id} label={c.name} bottomSeparator="standard" focusable>
						<ToggleField checked={currentRule.sourceIds.includes(c.id)} onChange={() => toggleSource(c.id)} />
					</Field>
				))}

			<Field
				label="Active rule"
				description={
					currentRule.sourceIds.length === 0
						? 'No rule — this collection is untouched'
						: `${currentRule.mode === 'exclude' ? 'Excluding' : 'Including only'} ${currentRule.sourceIds.length} collection(s)`
				}
				bottomSeparator="none"
			>
				<DialogButton onClick={clearRule}>Clear</DialogButton>
			</Field>
		</>
	);
};

/**
 * Startup waits minutes for Steam's store, so the plugin can be dismounted
 * while that is still pending. Without this flag the pending init would install
 * filters again straight after teardown released them.
 */
let dismounted = false;

/**
 * Applies one rule and persists it. Shared by the settings panel and the buckets
 * injected into Steam's own filter UI, so both write through the same path.
 */
function applyRule(collectionId: string, mode: FilterMode, sourceIds: string[]): void {
	const rules = loadRules();
	if (sourceIds.length === 0) delete rules[collectionId];
	else rules[collectionId] = { mode, sourceIds };
	saveRules(rules);
	engine.applyRules(rules);
}

/** Called by Millennium when the plugin is disabled or reloaded. */
function stop(): void {
	dismounted = true;
	try {
		stopNativeUi();
	} catch (error) {
		console.error('[Exclude collections] native UI teardown failed:', error);
	}
	try {
		engine.teardown();
	} catch (error) {
		console.error('[Exclude collections] teardown failed:', error);
	}
}

export default definePlugin(() => {
	dismounted = false;

	(async () => {
		const ready = await waitForStore();
		if (dismounted) return;
		if (!ready) {
			console.warn('[Exclude collections] collectionStore never became ready; rules not applied');
			return;
		}
		engine.applyRules(loadRules());
		startNativeUi({ getRules: loadRules, setRule: applyRule });
	})().catch((error) => console.error('[Exclude collections] Failed to apply stored rules:', error));

	return {
		title: 'Exclude collections in collection',
		icon: <IconsModule.Settings />,
		content: <SettingsContent />,
		onDismount: stop,
	};
});
