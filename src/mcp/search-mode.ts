export const SEARCH_MODES = ['semantic', 'text', 'hybrid'] as const
export type SearchMode = (typeof SEARCH_MODES)[number]
export const isSearchMode = (value: unknown): value is SearchMode => SEARCH_MODES.includes(value as SearchMode)
export const DEFAULT_SEARCH_MODE = 'hybrid' satisfies SearchMode
