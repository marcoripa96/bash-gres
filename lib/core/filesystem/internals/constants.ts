export const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_MAX_FILES = 10_000;
export const DEFAULT_MAX_DEPTH = 50;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_SYMLINK_DEPTH = 16;
export const DEFAULT_MAX_CP_NODES = 10_000;

export const DEFAULT_VERSION = "main";
export const TOMBSTONE = "tombstone";
export const DIFF_DEFAULT_BATCH_SIZE = 500;
export const DIFF_MAX_BATCH_SIZE = 5000;

/**
 * DETAIL of the error the `fs_versions_frozen_guard` trigger raises
 * (SQLSTATE 25006): how a refused write to a frozen version is told apart
 * from a read-only transaction.
 */
export const FROZEN_VERSION_DETAIL = "bash-gres: frozen version";
