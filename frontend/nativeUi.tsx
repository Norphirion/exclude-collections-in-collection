import { Dropdown, IconsModule, findClassModule } from '@steambrew/client';
import { createRoot, Root } from 'react-dom/client';
import { FilterMode, RuleMap } from './types';

/**
 * A data attribute rather than an id: the same bucket is injected into both the
 * editor and the creation pane, and two elements sharing an id would be invalid
 * and make any document-wide lookup return the wrong one.
 */
const HOST_ATTR = 'data-ecic-bucket';
const DESKTOP_POPUP = 'SP Desktop_uid0';
const POLL_MS = 1000;
/** How long to wait for Steam to materialise a freshly created collection. */
const CREATION_WATCH_MS = 15000;

interface FilterClasses {
	FilterArea: string;
	FilterBucket: string;
	FilterBucketLabel: string;
	FilterBucketBoxes: string;
	FilterStoreTag: string;
	SaveButton: string;
}

interface EditorClasses {
	CollectionEditor: string;
}

let filterClasses: FilterClasses | null = null;
let editorClasses: EditorClasses | null = null;

/** Steam's class names are content hashes, so they are resolved at runtime. */
function getClasses(): { filter: FilterClasses; editor: EditorClasses } | null {
	try {
		if (!filterClasses) filterClasses = findClassModule((m: any) => m.FilterBucket && m.FilterArea) as any;
		if (!editorClasses) editorClasses = findClassModule((m: any) => m.CollectionEditor) as any;
	} catch {
		return null;
	}
	if (!filterClasses?.FilterArea || !editorClasses?.CollectionEditor) return null;
	return { filter: filterClasses, editor: editorClasses };
}

function getMainDocument(): Document | null {
	try {
		return (window as any).g_PopupManager?.GetExistingPopup?.(DESKTOP_POPUP)?.window?.document ?? null;
	} catch {
		return null;
	}
}

function currentCollectionId(): string | null {
	try {
		const path: string | undefined = (window as any).MainWindowBrowserManager?.m_lastLocation?.pathname;
		const match = path?.match(/^\/library\/collection\/([^/]+)/);
		return match ? decodeURIComponent(match[1]) : null;
	} catch {
		return null;
	}
}

function listCollections(): { id: string; name: string }[] {
	try {
		const all = (window as any).collectionStore?.userCollections;
		if (!Array.isArray(all)) return [];
		return all.map((c: any) => ({ id: c.id, name: c.displayName }));
	} catch {
		return [];
	}
}

function listCollectionIds(): string[] {
	return listCollections().map((c) => c.id);
}

/**
 * Steam shows this filter UI in two places: the editor of an existing dynamic
 * collection, and the pane used to create a new one. The markup is identical, so
 * the same bucket renders in both — only the target differs, and a collection
 * being created has no id yet.
 */
interface Surface {
	area: HTMLElement;
	targetId: string | null;
}

function findSurfaces(doc: Document, cls: FilterClasses, ed: EditorClasses): Surface[] {
	const editor = doc.querySelector<HTMLElement>('.' + ed.CollectionEditor);
	const surfaces: Surface[] = [];

	for (const area of Array.from(doc.querySelectorAll<HTMLElement>('.' + cls.FilterArea))) {
		const visible =
			typeof area.checkVisibility !== 'function' ||
			area.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
		if (!visible) continue;
		const inEditor = !!editor && editor.contains(area);
		surfaces.push({ area, targetId: inEditor ? currentCollectionId() : null });
	}
	return surfaces;
}

export interface NativeUiHooks {
	getRules(): RuleMap;
	setRule(collectionId: string, mode: FilterMode, sourceIds: string[]): void;
}

const roots = new Map<HTMLElement, Root>();
let hooks: NativeUiHooks | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Choices made while creating a collection, applied once Steam assigns an id. */
let pending: Record<FilterMode, string[]> = { exclude: [], include: [] };
let creationWatcher: ReturnType<typeof setInterval> | null = null;

function readSelection(targetId: string | null, mode: FilterMode): string[] {
	if (!targetId) return pending[mode];
	const rule = hooks?.getRules()[targetId];
	return rule && rule.mode === mode ? rule.sourceIds : [];
}

function writeSelection(targetId: string | null, mode: FilterMode, ids: string[]): void {
	if (!targetId) {
		pending[mode] = ids;
		return;
	}
	hooks?.setRule(targetId, mode, ids);
}

function renderBucket(host: HTMLElement, surface: Surface, mode: FilterMode, cls: FilterClasses): void {
	const other: FilterMode = mode === 'exclude' ? 'include' : 'exclude';
	const collections = listCollections().filter((c) => c.id !== surface.targetId);
	const selected = readSelection(surface.targetId, mode);
	const takenByOther = readSelection(surface.targetId, other);
	const available = collections.filter((c) => !selected.includes(c.id));

	let root = roots.get(host);
	if (!root) {
		root = createRoot(host);
		roots.set(host, root);
	}

	root.render(
		<>
			<div className={cls.FilterBucketLabel}>
				{mode === 'exclude' ? 'Exclude collections' : 'Include collections'}
			</div>
			<Dropdown
				rgOptions={available.map((c) => ({
					data: c.id,
					// Collections already used by the other bucket stay listed but
					// greyed, so it is visible why they cannot be picked twice.
					label: takenByOther.includes(c.id) ? <span style={{ opacity: 0.35 }}>{c.name}</span> : c.name,
				}))}
				selectedOption={null}
				strDefaultLabel={available.length ? 'Add a collection…' : 'All added'}
				disabled={available.length === 0}
				onChange={(option: any) => {
					if (takenByOther.includes(option.data)) return;
					writeSelection(surface.targetId, mode, [...selected, option.data]);
					refresh();
				}}
			/>
			<div
				className={cls.FilterBucketBoxes}
				style={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: '4px',
					// Steam sizes this grid with `repeat(4, 1fr)`, and `1fr` resolves
					// against max-content when the container has no imposed width. The
					// max-content of a wrapping row is every chip on a single line, so
					// each added chip would widen all four columns. A definite `width`
					// contributes nothing to that measurement; `min-width` then fills the
					// column for real once the track has been sized.
					width: 0,
					minWidth: '100%',
				}}
			>
				{selected.map((id) => {
					const collection = collections.find((c) => c.id === id);
					return (
						<div
							key={id}
							className={cls.FilterStoreTag}
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								gap: '6px',
								cursor: 'pointer',
								// A long collection name must not be able to stretch the
								// column: cap the chip and clip the label instead.
								maxWidth: '100%',
								minWidth: 0,
							}}
							title={collection ? collection.name : id}
							onClick={() => {
								writeSelection(
									surface.targetId,
									mode,
									selected.filter((x) => x !== id)
								);
								refresh();
							}}
						>
							<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
								{collection ? collection.name : id}
							</span>
							<IconsModule.Close style={{ width: '10px', height: '10px', color: '#e05c5c', flexShrink: 0 }} />
						</div>
					);
				})}
			</div>
		</>
	);
}

function ensureBuckets(surface: Surface, cls: FilterClasses, doc: Document): void {
	const modes: FilterMode[] = ['exclude', 'include'];
	modes.forEach((mode, index) => {
		let host = surface.area.querySelector<HTMLElement>(`[${HOST_ATTR}="${mode}"]`);
		if (!host) {
			host = doc.createElement('div');
			host.setAttribute(HOST_ATTR, mode);
			host.className = cls.FilterBucket + ' Panel';
			// Steam gives its own buckets an explicit CSS order, so without one ours
			// would render first. No width is set on purpose: letting the grid size
			// them is what keeps the panel responsive at every window size.
			host.style.order = String(98 + index);
			// Grid items default to `min-width: auto`, which lets their content set
			// the column width. Without this, adding chips widens every column of
			// Steam's filter grid.
			host.style.minWidth = '0';
			surface.area.appendChild(host);
		}
		renderBucket(host, surface, mode, cls);
	});
}

/** Watches for the collection Steam creates when the creation pane is saved. */
function watchForCreatedCollection(before: string[]): void {
	if (creationWatcher !== null) return;
	const started = Date.now();

	creationWatcher = setInterval(() => {
		const created = listCollectionIds().find((id) => !before.includes(id));
		const expired = Date.now() - started > CREATION_WATCH_MS;

		if (created) {
			const modes: FilterMode[] = ['exclude', 'include'];
			for (const mode of modes) {
				if (pending[mode].length) hooks?.setRule(created, mode, pending[mode]);
			}
		}
		if (created || expired) {
			pending = { exclude: [], include: [] };
			if (creationWatcher !== null) clearInterval(creationWatcher);
			creationWatcher = null;
		}
	}, 500);
}

function armSaveButton(doc: Document, cls: FilterClasses): void {
	const button = doc.querySelector<HTMLElement>('.' + cls.SaveButton);
	if (!button || button.dataset.ecicArmed === '1') return;
	button.dataset.ecicArmed = '1';
	button.addEventListener('click', () => watchForCreatedCollection(listCollectionIds()));
}

function pruneDetachedRoots(): void {
	for (const [host, root] of Array.from(roots)) {
		if (host.isConnected) continue;
		try {
			root.unmount();
		} catch {
			// the host is already gone; nothing left to release
		}
		roots.delete(host);
	}
}

function refresh(): void {
	pruneDetachedRoots();

	const doc = getMainDocument();
	const classes = getClasses();
	if (!doc || !classes) return;

	const surfaces = findSurfaces(doc, classes.filter, classes.editor);
	for (const surface of surfaces) ensureBuckets(surface, classes.filter, doc);
	if (surfaces.some((s) => s.targetId === null)) armSaveButton(doc, classes.filter);
}

export function startNativeUi(next: NativeUiHooks): void {
	hooks = next;
	if (pollTimer !== null) return;
	// Polling rather than a navigation hook: React owns these panels and drops our
	// nodes whenever it re-renders them, which a one-shot hook would not catch.
	pollTimer = setInterval(() => {
		try {
			refresh();
		} catch (error) {
			console.error('[Exclude collections] native UI refresh failed:', error);
		}
	}, POLL_MS);
}

export function stopNativeUi(): void {
	if (pollTimer !== null) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	if (creationWatcher !== null) {
		clearInterval(creationWatcher);
		creationWatcher = null;
	}
	for (const [host, root] of Array.from(roots)) {
		try {
			root.unmount();
		} catch {
			// already gone
		}
		host.remove();
	}
	roots.clear();
	hooks = null;
}
