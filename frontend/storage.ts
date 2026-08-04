import { RuleMap } from './types';

// Keeps the plugin's original name on purpose: renaming the key would orphan
// every rule a user has already saved.
const STORAGE_KEY = 'collection-filter-rules';

export function loadRules(): RuleMap {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch (error) {
		console.error('[Exclude collections] Failed to load rules:', error);
		return {};
	}
}

export function saveRules(rules: RuleMap): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
	} catch (error) {
		console.error('[Exclude collections] Failed to save rules:', error);
	}
}
