-- Record the exact inference environment used by every embedding build.
-- Audio results from different precisions/devices must remain distinguishable.

ALTER TABLE voice_bank_versions
    ADD COLUMN IF NOT EXISTS engine_model_version TEXT,
    ADD COLUMN IF NOT EXISTS engine_model_revision TEXT,
    ADD COLUMN IF NOT EXISTS engine_source_revision TEXT,
    ADD COLUMN IF NOT EXISTS engine_package_version TEXT,
    ADD COLUMN IF NOT EXISTS engine_precision TEXT,
    ADD COLUMN IF NOT EXISTS engine_device TEXT,
    ADD COLUMN IF NOT EXISTS engine_url TEXT;
