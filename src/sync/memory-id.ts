// The session external_id for a memory file. Namespaced so it can never
// collide with a transcript's session id (a uuid) inside the same project.
export const memoryExternalId = (fileName: string): string => `memory:${fileName}`

// Matches every memory session's external_id in SQL `LIKE`. Derived from the
// writer's own id, so the namespace is stated once.
export const MEMORY_EXTERNAL_ID_LIKE = memoryExternalId('%')
