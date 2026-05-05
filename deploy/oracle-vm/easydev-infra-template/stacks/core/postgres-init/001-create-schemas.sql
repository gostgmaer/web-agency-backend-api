-- Runs only when PostgreSQL data directory is initialized for the first time.
-- This keeps one physical database while isolating business domains by schema.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS payment;
CREATE SCHEMA IF NOT EXISTS ai_automation_communication;
