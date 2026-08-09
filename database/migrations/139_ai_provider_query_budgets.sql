-- Migration 139: Per-provider AI Assistant query budgets
--
-- The AI_QUERY_* environment variables size the tool-calling loop for the
-- centrally managed provider (AI_DEFAULT_PROVIDER), which no user can edit.
-- A provider a user configured for themselves carries its own budgets here,
-- edited in AI Settings; NULL means "use the built-in default", never the
-- environment. See backend/src/ai/query/query-budgets.ts.

ALTER TABLE ai_provider_configs
    ADD COLUMN IF NOT EXISTS query_max_iterations INTEGER,
    ADD COLUMN IF NOT EXISTS query_max_tool_calls INTEGER,
    ADD COLUMN IF NOT EXISTS query_timeout_minutes INTEGER,
    ADD COLUMN IF NOT EXISTS query_max_input_tokens INTEGER,
    ADD COLUMN IF NOT EXISTS query_max_tool_result_chars INTEGER;
