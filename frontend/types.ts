export type FilterMode = 'include' | 'exclude';

/** A rule attached to one target (dynamic) collection. */
export interface CollectionRule {
	mode: FilterMode;
	/** Ids of the collections used as the source pool for the rule. */
	sourceIds: string[];
}

/** All rules, keyed by the id of the collection they apply to. */
export type RuleMap = Record<string, CollectionRule>;

export interface CollectionInfo {
	id: string;
	name: string;
	isDynamic: boolean;
}
