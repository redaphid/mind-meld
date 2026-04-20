-- Safety net against runaway queries.
-- A bad anti-join pattern (SELECT ... WHERE id NOT IN (SELECT ...)) once pinned
-- three postgres workers for an hour. An upper bound at the role level lets
-- postgres kill such queries without us having to notice and intervene.
--
-- Persisted in pg_db_role_setting; survives restarts.
-- Takes effect on new connections (existing sessions are unaffected).

ALTER ROLE mindmeld SET statement_timeout = '120s';
