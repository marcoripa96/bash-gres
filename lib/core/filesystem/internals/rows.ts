export interface EntryRow {
  workspace_id: string;
  version_id: number;
  path: string;
  blob_hash: Uint8Array | null;
  node_type: string;
  symlink_target: string | null;
  mode: number;
  size_bytes: number;
  mtime: Date;
  created_at: Date;
}

/** One visible entry plus its blob, as readFile fetches it. */
export interface FileReadRow {
  path: string;
  blob_hash: Uint8Array | null;
  node_type: string;
  symlink_target: string | null;
  size_bytes: number | string;
  blob_content: string | null;
  blob_binary_data: Uint8Array | null;
}

/** One stored chunk row of a blob, as readFileChunks fetches it. */
export interface ChunkRow {
  chunk_index: number;
  start_line: number;
  end_line: number;
  heading_path: string | null;
  content: string;
}

export interface BlobRow {
  hash: Uint8Array;
  content: string | null;
  binary_data: Uint8Array | null;
  size_bytes: number;
}

export interface DirChildRow {
  path: string;
  node_type: string;
  blob_hash: Uint8Array | null;
  symlink_target: string | null;
  mode: number;
  size_bytes: number;
  mtime: Date;
}

export interface SubtreeRow extends DirChildRow {
  depth_in_subtree: number;
}

export interface DiffRow {
  path: string;
  o_type: string | null;
  o_hash: Uint8Array | null;
  o_link: string | null;
  o_mode: number | null;
  o_size: number | string | null;
  o_mtime: Date | null;
  o_content: string | null;
  o_binary: Uint8Array | null;
  t_type: string | null;
  t_hash: Uint8Array | null;
  t_link: string | null;
  t_mode: number | null;
  t_size: number | string | null;
  t_mtime: Date | null;
  t_content: string | null;
  t_binary: Uint8Array | null;
}

export interface UsageRow {
  versions: number | string;
  entry_rows: number | string;
  tombstone_rows: number | string;
  blob_count: number | string;
  stored_blob_bytes: number | string;
  referenced_blob_bytes: number | string;
  visible_nodes: number | string;
  visible_files: number | string;
  visible_directories: number | string;
  visible_symlinks: number | string;
  logical_bytes: number | string;
  across_referenced_blob_bytes: number | string | null;
  across_referenced_blob_count: number | string | null;
}

export interface VersionRootRow {
  id: number | string;
  path: string;
}
