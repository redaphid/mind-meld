// The id a session's summary vector is stored under in the sessions collection.
// Written by the embedder, read by search and the noise penalty, and matched in
// SQL by pending.ts -- one spelling for all of them.
export const SESSION_VECTOR_PREFIX = 'session-'

export const sessionVectorId = (sessionId: number) => `${SESSION_VECTOR_PREFIX}${sessionId}`

export const sessionIdFromVectorId = (id: string) => Number(id.slice(SESSION_VECTOR_PREFIX.length))
