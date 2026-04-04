import { randomUUID } from "crypto";
import type {
  SqlClient,
  PgFileSystemOptions,
  FsPermissions,
  FsStat,
  DirentEntry,
  MkdirOptions,
  RmOptions,
  CpOptions,
  ReadFileOptions,
  SearchResult,
} from "./types.js";
import { FsError, SqlError } from "./types.js";
import { readonlySqlClient } from "./readonly.js";
import {
  pathToLtree,
  ltreeToPath,
  normalizePath,
  parentPath,
  fileName,
} from "./path-encoding.js";
import { fullTextSearch, semanticSearch, hybridSearch, validateEmbedding } from "./search.js";

interface FsRow {
  id: number;
  workspace_id: string;
  parent_id: number | null;
  name: string;
  node_type: string;
  path: string;
  content: string | null;
  binary_data: Uint8Array | null;
  symlink_target: string | null;
  mode: number;
  size_bytes: number;
  mtime: Date;
  created_at: Date;
}

type FsRowMeta = Omit<FsRow, "content" | "binary_data">;

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_DEPTH = 50;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
const MAX_SYMLINK_DEPTH = 16;
const MAX_CP_NODES = 10_000;

export class PgFileSystem {
  private client: SqlClient;
  readonly workspaceId: string;
  readonly permissions: { read: boolean; write: boolean };
  private maxFileSize: number;
  private maxReadSize: number | undefined;
  private maxFiles: number;
  private maxDepth: number;
  private statementTimeoutMs: number;
  private embed?: (text: string) => Promise<number[]>;
  private embeddingDimensions?: number;

  constructor(options: PgFileSystemOptions) {
    const perms = {
      read: options.permissions?.read ?? true,
      write: options.permissions?.write ?? true,
    };
    this.permissions = perms;
    this.client = perms.write ? options.db : readonlySqlClient(options.db);
    this.workspaceId = options.workspaceId ?? randomUUID();
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.maxReadSize = options.maxReadSize;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.statementTimeoutMs =
      options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    this.embed = options.embed;
    this.embeddingDimensions = options.embeddingDimensions;
  }

  async init(): Promise<void> {
    await this.withWorkspace(async (tx) => {
      const rootLtree = pathToLtree("/", this.workspaceId);
      await tx.query(
        `INSERT INTO fs_nodes (workspace_id, name, node_type, path, mode)
         VALUES ($1, '/', 'directory', $2::ltree, $3)
         ON CONFLICT (workspace_id, path) DO NOTHING`,
        [this.workspaceId, rootLtree, 0o755],
      );
    });
  }

  // -- Transaction wrapper (sets RLS context + timeout) -----------------------

  private withWorkspace<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.workspace_id', $1, true)", [
        this.workspaceId,
      ]);
      await tx.query("SELECT set_config('statement_timeout', $1, true)", [
        String(this.statementTimeoutMs),
      ]);
      return fn(tx);
    }).catch((e) => {
      if (e instanceof SqlError && e.code === "25006") {
        throw new FsError("EPERM", "read-only file system", "/");
      }
      throw e;
    });
  }

  // -- Low-level helpers ------------------------------------------------------

  private async getNode(tx: SqlClient, posixPath: string): Promise<FsRow | null> {
    const lt = pathToLtree(posixPath, this.workspaceId);
    const result = await tx.query<FsRow>(
      `SELECT * FROM fs_nodes
       WHERE workspace_id = $1 AND path = $2::ltree
       LIMIT 1`,
      [this.workspaceId, lt],
    );
    return result.rows[0] ?? null;
  }

  private async getNodeMeta(
    tx: SqlClient,
    posixPath: string,
  ): Promise<FsRowMeta | null> {
    const lt = pathToLtree(posixPath, this.workspaceId);
    const result = await tx.query<FsRowMeta>(
      `SELECT id, workspace_id, parent_id, name, node_type, path,
              symlink_target, mode, size_bytes, mtime, created_at
       FROM fs_nodes
       WHERE workspace_id = $1 AND path = $2::ltree
       LIMIT 1`,
      [this.workspaceId, lt],
    );
    return result.rows[0] ?? null;
  }

  private async getNodeForUpdate(
    tx: SqlClient,
    posixPath: string,
  ): Promise<FsRow | null> {
    const lt = pathToLtree(posixPath, this.workspaceId);
    const result = await tx.query<FsRow>(
      `SELECT * FROM fs_nodes
       WHERE workspace_id = $1 AND path = $2::ltree
       LIMIT 1
       FOR UPDATE`,
      [this.workspaceId, lt],
    );
    return result.rows[0] ?? null;
  }

  private async resolveSymlink(
    tx: SqlClient,
    path: string,
    maxDepth = MAX_SYMLINK_DEPTH,
  ): Promise<FsRow> {
    const node = await this.getNode(tx, path);
    if (!node) throw new FsError("ENOENT", "no such file or directory", path);
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0)
        throw new FsError("ELOOP", "too many levels of symbolic links", path);
      return this.resolveSymlink(
        tx,
        this.resolveLinkTargetPath(path, node.symlink_target),
        maxDepth - 1,
      );
    }
    return node;
  }

  private async resolveSymlinkMeta(
    tx: SqlClient,
    path: string,
    maxDepth = MAX_SYMLINK_DEPTH,
  ): Promise<FsRowMeta> {
    const node = await this.getNodeMeta(tx, path);
    if (!node) throw new FsError("ENOENT", "no such file or directory", path);
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0)
        throw new FsError("ELOOP", "too many levels of symbolic links", path);
      return this.resolveSymlinkMeta(
        tx,
        this.resolveLinkTargetPath(path, node.symlink_target),
        maxDepth - 1,
      );
    }
    return node;
  }

  private resolveLinkTargetPath(linkPath: string, target: string): string {
    if (target.startsWith("/")) {
      return normalizePath(target);
    }
    return this.resolvePath(parentPath(linkPath), target);
  }

  private validateFileSize(content: string | Uint8Array): void {
    const size =
      typeof content === "string"
        ? new TextEncoder().encode(content).byteLength
        : content.byteLength;
    if (size > this.maxFileSize) {
      throw new Error(
        `File too large: ${size} bytes exceeds maximum of ${this.maxFileSize} bytes`,
      );
    }
  }

  private async validateNodeCount(tx: SqlClient): Promise<void> {
    const result = await tx.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM fs_nodes WHERE workspace_id = $1`,
      [this.workspaceId],
    );
    if (result.rows[0] && result.rows[0].count >= this.maxFiles) {
      throw new Error(
        `Node limit reached: ${this.maxFiles} nodes per workspace`,
      );
    }
  }

  private validatePathDepth(path: string): void {
    const depth = path.split("/").filter(Boolean).length;
    if (depth > this.maxDepth) {
      throw new Error(
        `Path too deep: ${depth} levels exceeds maximum of ${this.maxDepth}`,
      );
    }
  }

  // -- Internal write ---------------------------------------------------------

  private async internalWriteFile(
    tx: SqlClient,
    path: string,
    content: string | Uint8Array,
    precomputedEmbedding?: number[] | null,
  ): Promise<void> {
    this.validateFileSize(content);
    this.validatePathDepth(path);

    const name = fileName(path);
    const parentPosix = parentPath(path);
    const parent = await this.getNodeMeta(tx, parentPosix);
    if (!parent)
      throw new FsError("ENOENT", "no such file or directory, open", path);

    const existing = await this.getNodeMeta(tx, path);
    if (existing?.node_type === "directory")
      throw new FsError("EISDIR", "illegal operation on a directory, open", path);

    if (!existing) {
      await this.validateNodeCount(tx);
    }

    const lt = pathToLtree(path, this.workspaceId);
    const isText = typeof content === "string";
    const textContent = isText ? content : null;
    const binaryData = isText ? null : content;
    const sizeBytes = isText
      ? new TextEncoder().encode(content).byteLength
      : content.byteLength;

    let embedding: number[] | null = null;
    if (precomputedEmbedding !== undefined) {
      embedding = precomputedEmbedding;
    } else if (isText && this.embed && content.length > 0) {
      embedding = await this.embed(content);
      if (embedding) validateEmbedding(embedding, this.embeddingDimensions);
    }

    if (embedding) {
      const embeddingStr = `[${embedding.join(",")}]`;
      await tx.query(
        `INSERT INTO fs_nodes (workspace_id, parent_id, name, node_type, path, content, binary_data, size_bytes, mtime, embedding)
         VALUES ($1, $2, $3, 'file', $4::ltree, $5, $6, $7, now(), $8::vector)
         ON CONFLICT (workspace_id, path) DO UPDATE SET
           content = EXCLUDED.content,
           binary_data = EXCLUDED.binary_data,
           size_bytes = EXCLUDED.size_bytes,
           mtime = now(),
           embedding = EXCLUDED.embedding`,
        [this.workspaceId, parent.id, name, lt, textContent, binaryData, sizeBytes, embeddingStr],
      );
    } else {
      await tx.query(
        `INSERT INTO fs_nodes (workspace_id, parent_id, name, node_type, path, content, binary_data, size_bytes, mtime)
         VALUES ($1, $2, $3, 'file', $4::ltree, $5, $6, $7, now())
         ON CONFLICT (workspace_id, path) DO UPDATE SET
           content = EXCLUDED.content,
           binary_data = EXCLUDED.binary_data,
           size_bytes = EXCLUDED.size_bytes,
           mtime = now()`,
        [this.workspaceId, parent.id, name, lt, textContent, binaryData, sizeBytes],
      );
    }
  }

  // -- Internal mkdir ---------------------------------------------------------

  private async internalMkdir(
    tx: SqlClient,
    path: string,
    options?: MkdirOptions,
  ): Promise<void> {
    this.validatePathDepth(path);
    const recursive = options?.recursive ?? false;

    if (recursive) {
      const segments = path.split("/").filter(Boolean);
      const allPaths: string[] = [];
      const allLtrees: string[] = [];
      const allNames: string[] = [];
      let current = "/";

      for (const segment of segments) {
        current = current === "/" ? `/${segment}` : `${current}/${segment}`;
        allPaths.push(current);
        allLtrees.push(pathToLtree(current, this.workspaceId));
        allNames.push(segment);
      }

      const existingResult = await tx.query<{ path: string; node_type: string }>(
        `SELECT path::text, node_type FROM fs_nodes
         WHERE workspace_id = $1
           AND path = ANY($2::text[]::ltree[])`,
        [this.workspaceId, allLtrees],
      );
      const existingMap = new Map(
        existingResult.rows.map((r) => [r.path, r.node_type]),
      );

      for (let i = 0; i < allLtrees.length; i++) {
        const nodeType = existingMap.get(allLtrees[i]);
        if (nodeType && nodeType !== "directory") {
          throw new FsError("ENOTDIR", "not a directory, mkdir", allPaths[i]);
        }
      }

      for (let i = 0; i < allLtrees.length; i++) {
        if (!existingMap.has(allLtrees[i])) {
          const parentLt =
            i === 0
              ? pathToLtree("/", this.workspaceId)
              : allLtrees[i - 1];
          await tx.query(
            `INSERT INTO fs_nodes (workspace_id, parent_id, name, node_type, path, mode)
             SELECT $1, p.id, $2, 'directory', $3::ltree, $4
             FROM fs_nodes p
             WHERE p.workspace_id = $1
               AND p.path = $5::ltree
             ON CONFLICT (workspace_id, path) DO NOTHING`,
            [this.workspaceId, allNames[i], allLtrees[i], 0o755, parentLt],
          );
        }
      }
    } else {
      const existing = await this.getNodeMeta(tx, path);
      if (existing)
        throw new FsError("EEXIST", "file already exists, mkdir", path);
      const parentPosix = parentPath(path);
      const parent = await this.getNodeMeta(tx, parentPosix);
      if (!parent)
        throw new FsError(
          "ENOENT",
          "no such file or directory, mkdir",
          path,
        );
      const name = fileName(path);
      const lt = pathToLtree(path, this.workspaceId);
      await tx.query(
        `INSERT INTO fs_nodes (workspace_id, parent_id, name, node_type, path, mode)
         VALUES ($1, $2, $3, 'directory', $4::ltree, $5)`,
        [this.workspaceId, parent.id, name, lt, 0o755],
      );
    }
  }

  // -- Internal readdir -------------------------------------------------------

  private async internalReaddir(
    tx: SqlClient,
    path: string,
  ): Promise<string[]> {
    const node = await this.getNodeMeta(tx, path);
    if (!node)
      throw new FsError("ENOENT", "no such file or directory, scandir", path);
    if (node.node_type !== "directory")
      throw new FsError("ENOTDIR", "not a directory, scandir", path);

    const result = await tx.query<{ name: string }>(
      `SELECT name FROM fs_nodes
       WHERE workspace_id = $1 AND parent_id = $2
       ORDER BY name`,
      [this.workspaceId, node.id],
    );
    return result.rows.map((r) => r.name);
  }

  // -- Internal cp ------------------------------------------------------------

  private async internalCp(
    tx: SqlClient,
    src: string,
    dest: string,
    options?: CpOptions,
    counter?: { count: number },
  ): Promise<void> {
    const nodeCounter = counter ?? { count: 0 };

    if (dest.startsWith(src + "/") || dest === src) {
      throw new FsError(
        "EINVAL",
        "cannot copy to a subdirectory of itself, cp",
        src,
      );
    }

    const srcNode = await this.getNode(tx, src);
    if (!srcNode)
      throw new FsError("ENOENT", "no such file or directory, cp", src);

    nodeCounter.count++;
    if (nodeCounter.count > MAX_CP_NODES) {
      throw new Error(`cp: too many nodes (exceeds limit of ${MAX_CP_NODES})`);
    }

    if (srcNode.node_type === "directory") {
      if (!options?.recursive) {
        throw new FsError("EISDIR", "illegal operation on a directory, cp", src);
      }
      await this.internalMkdir(tx, dest, { recursive: true });
      const children = await this.internalReaddir(tx, src);
      for (const child of children) {
        const srcChild = src === "/" ? `/${child}` : `${src}/${child}`;
        const destChild = dest === "/" ? `/${child}` : `${dest}/${child}`;
        await this.internalCp(tx, srcChild, destChild, options, nodeCounter);
      }
      return;
    }

    const content =
      srcNode.content !== null
        ? srcNode.content
        : srcNode.binary_data ?? new Uint8Array(0);
    await this.internalWriteFile(tx, dest, content, null);
  }

  // -- Public API: File I/O ---------------------------------------------------

  async readFile(path: string, options?: ReadFileOptions): Promise<string> {
    const hasRange = options?.offset !== undefined || options?.limit !== undefined;

    return this.withWorkspace(async (tx) => {
      const p = normalizePath(path);

      if (hasRange) {
        const node = await this.resolveSymlinkMeta(tx, p);
        if (node.node_type === "directory")
          throw new FsError("EISDIR", "illegal operation on a directory, read", path);

        const sqlOffset = (options?.offset ?? 0) + 1; // SQL SUBSTRING is 1-based
        const sqlLimit = options?.limit;

        const substringExpr = sqlLimit !== undefined
          ? `substr(COALESCE(content, ''), $3, $4)`
          : `substr(COALESCE(content, ''), $3)`;

        const params: (string | number)[] = [this.workspaceId, pathToLtree(p, this.workspaceId), sqlOffset];
        if (sqlLimit !== undefined) params.push(sqlLimit);

        const result = await tx.query<{ chunk: string }>(
          `SELECT ${substringExpr} AS chunk FROM fs_nodes
           WHERE workspace_id = $1 AND path = $2::ltree
           LIMIT 1`,
          params,
        );
        return result.rows[0]?.chunk ?? "";
      }

      const node = await this.resolveSymlink(tx, p);
      if (node.node_type === "directory")
        throw new FsError("EISDIR", "illegal operation on a directory, read", path);

      const size = node.size_bytes;
      if (this.maxReadSize !== undefined && size > this.maxReadSize) {
        throw new FsError(
          "E2BIG",
          `file too large to read (${size} bytes, max ${this.maxReadSize}). Use readFile with { offset, limit } to read in chunks`,
          path,
        );
      }

      if (node.content !== null) return node.content;
      if (node.binary_data !== null)
        return new TextDecoder().decode(node.binary_data);
      return "";
    });
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.withWorkspace(async (tx) => {
      const p = normalizePath(path);
      const node = await this.resolveSymlink(tx, p);
      if (node.node_type === "directory")
        throw new FsError(
          "EISDIR",
          "illegal operation on a directory, read",
          path,
        );
      if (node.binary_data !== null) return node.binary_data;
      if (node.content !== null) return new TextEncoder().encode(node.content);
      return new Uint8Array(0);
    });
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const normalized = normalizePath(path);

    let embedding: number[] | null = null;
    if (typeof content === "string" && this.embed && content.length > 0) {
      embedding = await this.embed(content);
      if (embedding) validateEmbedding(embedding, this.embeddingDimensions);
    }

    return this.withWorkspace(async (tx) => {
      if (options?.recursive) {
        const parent = parentPath(normalized);
        if (parent !== "/") {
          await this.internalMkdir(tx, parent, { recursive: true });
        }
      }
      await this.internalWriteFile(tx, normalized, content, embedding);
    });
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    return this.withWorkspace(async (tx) => {
      const p = normalizePath(path);
      const existing = await this.getNodeForUpdate(tx, p);

      if (!existing) {
        await this.internalWriteFile(tx, p, content);
        return;
      }

      const appendSize =
        typeof content === "string"
          ? new TextEncoder().encode(content).byteLength
          : content.byteLength;

      if (existing.size_bytes + appendSize > this.maxFileSize) {
        throw new Error(
          `File too large: ${existing.size_bytes + appendSize} bytes exceeds maximum of ${this.maxFileSize} bytes`,
        );
      }

      if (existing.binary_data !== null || typeof content !== "string") {
        const existingBytes =
          existing.binary_data ??
          (existing.content !== null
            ? new TextEncoder().encode(existing.content)
            : new Uint8Array(0));
        const appendBytes =
          typeof content === "string"
            ? new TextEncoder().encode(content)
            : content;
        const merged = new Uint8Array(
          existingBytes.byteLength + appendBytes.byteLength,
        );
        merged.set(new Uint8Array(existingBytes), 0);
        merged.set(new Uint8Array(appendBytes), existingBytes.byteLength);
        await this.internalWriteFile(tx, p, merged);
      } else {
        await this.internalWriteFile(tx, p, (existing.content ?? "") + content);
      }
    });
  }

  // -- Public API: Path queries -----------------------------------------------

  async exists(path: string): Promise<boolean> {
    return this.withWorkspace(async (tx) => {
      const node = await this.getNodeMeta(tx, normalizePath(path));
      return node !== null;
    });
  }

  async stat(path: string): Promise<FsStat> {
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveSymlinkMeta(tx, normalizePath(path));
      return {
        isFile: node.node_type === "file",
        isDirectory: node.node_type === "directory",
        isSymbolicLink: false,
        mode: node.mode,
        size: Number(node.size_bytes),
        mtime: new Date(node.mtime),
      };
    });
  }

  async lstat(path: string): Promise<FsStat> {
    return this.withWorkspace(async (tx) => {
      const p = normalizePath(path);
      const node = await this.getNodeMeta(tx, p);
      if (!node)
        throw new FsError(
          "ENOENT",
          "no such file or directory, lstat",
          path,
        );
      return {
        isFile: node.node_type === "file",
        isDirectory: node.node_type === "directory",
        isSymbolicLink: node.node_type === "symlink",
        mode: node.mode,
        size: Number(node.size_bytes),
        mtime: new Date(node.mtime),
      };
    });
  }

  async realpath(path: string): Promise<string> {
    return this.withWorkspace(async (tx) => {
      return this.internalRealpath(tx, normalizePath(path));
    });
  }

  private async internalRealpath(
    tx: SqlClient,
    path: string,
    maxDepth = MAX_SYMLINK_DEPTH,
  ): Promise<string> {
    const node = await this.getNodeMeta(tx, path);
    if (!node)
      throw new FsError(
        "ENOENT",
        "no such file or directory, realpath",
        path,
      );
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0)
        throw new FsError(
          "ELOOP",
          "too many levels of symbolic links, realpath",
          path,
        );
      return this.internalRealpath(
        tx,
        this.resolveLinkTargetPath(path, node.symlink_target),
        maxDepth - 1,
      );
    }
    return ltreeToPath(node.path);
  }

  // -- Public API: Directory operations ---------------------------------------

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return this.withWorkspace(async (tx) => {
      await this.internalMkdir(tx, normalizePath(path), options);
    });
  }

  async readdir(path: string): Promise<string[]> {
    return this.withWorkspace(async (tx) => {
      const p = normalizePath(path);
      const node = await this.resolveSymlinkMeta(tx, p);
      if (node.node_type !== "directory") {
        throw new FsError("ENOTDIR", "not a directory, scandir", path);
      }
      return this.internalReaddir(tx, ltreeToPath(node.path));
    });
  }

  async readdirWithTypes(path: string): Promise<DirentEntry[]> {
    return this.withWorkspace(async (tx) => {
      const p = normalizePath(path);
      const node = await this.resolveSymlinkMeta(tx, p);
      if (!node)
        throw new FsError(
          "ENOENT",
          "no such file or directory, scandir",
          path,
        );
      if (node.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, scandir", path);

      const result = await tx.query<{ name: string; node_type: string }>(
        `SELECT name, node_type FROM fs_nodes
         WHERE workspace_id = $1 AND parent_id = $2
         ORDER BY name`,
        [this.workspaceId, node.id],
      );
      return result.rows.map((r) => ({
        name: r.name,
        isFile: r.node_type === "file",
        isDirectory: r.node_type === "directory",
        isSymbolicLink: r.node_type === "symlink",
      }));
    });
  }

  // -- Public API: Mutation ---------------------------------------------------

  async rm(path: string, options?: RmOptions): Promise<void> {
    return this.withWorkspace(async (tx) => {
      const p = normalizePath(path);
      const node = await this.getNodeMeta(tx, p);

      if (!node) {
        if (options?.force) return;
        throw new FsError("ENOENT", "no such file or directory, rm", path);
      }

      if (node.node_type === "directory") {
        if (!options?.recursive) {
          const children = await tx.query(
            `SELECT 1 FROM fs_nodes
             WHERE workspace_id = $1 AND parent_id = $2
             LIMIT 1`,
            [this.workspaceId, node.id],
          );
          if (children.rows.length > 0) {
            throw new FsError(
              "ENOTEMPTY",
              "directory not empty, rm",
              path,
            );
          }
        }
      }

      if (options?.recursive && node.node_type === "directory") {
        const lt = pathToLtree(p, this.workspaceId);
        // Delete leaves first to satisfy ON DELETE RESTRICT
        await tx.query(
          `WITH RECURSIVE subtree AS (
             SELECT id, path, 0 AS depth FROM fs_nodes
             WHERE workspace_id = $1 AND path <@ $2::ltree
           )
           DELETE FROM fs_nodes
           WHERE workspace_id = $1
             AND id IN (SELECT id FROM subtree)
             AND id NOT IN (
               SELECT DISTINCT parent_id FROM fs_nodes
               WHERE workspace_id = $1 AND parent_id IS NOT NULL
                 AND id IN (SELECT id FROM subtree)
             )`,
          [this.workspaceId, lt],
        );
        // Repeatedly delete now-childless nodes until all are gone
        let remaining = true;
        while (remaining) {
          const result = await tx.query(
            `DELETE FROM fs_nodes
             WHERE workspace_id = $1 AND path <@ $2::ltree
             AND id NOT IN (
               SELECT DISTINCT parent_id FROM fs_nodes
               WHERE workspace_id = $1 AND parent_id IS NOT NULL
             )`,
            [this.workspaceId, lt],
          );
          remaining = (result.rowCount ?? 0) > 0;
        }
      } else {
        await tx.query(
          `DELETE FROM fs_nodes WHERE workspace_id = $1 AND id = $2`,
          [this.workspaceId, node.id],
        );
      }
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    return this.withWorkspace(async (tx) => {
      await this.internalCp(
        tx,
        normalizePath(src),
        normalizePath(dest),
        options,
      );
    });
  }

  async mv(src: string, dest: string): Promise<void> {
    return this.withWorkspace(async (tx) => {
      const srcPath = normalizePath(src);
      const destPath = normalizePath(dest);

      if (destPath.startsWith(srcPath + "/") || destPath === srcPath) {
        throw new FsError(
          "EINVAL",
          "cannot move to a subdirectory of itself, mv",
          src,
        );
      }

      const srcNode = await this.getNodeForUpdate(tx, srcPath);
      if (!srcNode)
        throw new FsError("ENOENT", "no such file or directory, mv", src);

      const destParentPosix = parentPath(destPath);
      const destParent = await this.getNodeMeta(tx, destParentPosix);
      if (!destParent)
        throw new FsError("ENOENT", "no such file or directory, mv", dest);

      const destNode = await this.getNodeMeta(tx, destPath);
      if (destNode) {
        if (
          destNode.node_type === "directory" &&
          srcNode.node_type !== "directory"
        ) {
          throw new FsError(
            "EISDIR",
            "cannot overwrite directory with non-directory, mv",
            dest,
          );
        }
        if (
          destNode.node_type !== "directory" &&
          srcNode.node_type === "directory"
        ) {
          throw new FsError(
            "ENOTDIR",
            "cannot overwrite non-directory with directory, mv",
            dest,
          );
        }
        if (destNode.node_type === "directory") {
          const children = await tx.query(
            `SELECT 1 FROM fs_nodes
             WHERE workspace_id = $1 AND parent_id = $2
             LIMIT 1`,
            [this.workspaceId, destNode.id],
          );
          if (children.rows.length > 0) {
            throw new FsError("ENOTEMPTY", "directory not empty, mv", dest);
          }
        }
        await tx.query(
          `DELETE FROM fs_nodes WHERE workspace_id = $1 AND id = $2`,
          [this.workspaceId, destNode.id],
        );
      }

      const newName = fileName(destPath);
      const newLtree = pathToLtree(destPath, this.workspaceId);
      const oldLtree = pathToLtree(srcPath, this.workspaceId);

      // Lock all descendant rows before path rewrite
      if (srcNode.node_type === "directory") {
        await tx.query(
          `SELECT id FROM fs_nodes
           WHERE workspace_id = $1 AND path <@ $2::ltree
           ORDER BY path
           FOR UPDATE`,
          [this.workspaceId, oldLtree],
        );
      }

      await tx.query(
        `UPDATE fs_nodes
         SET name = $1, path = $2::ltree, parent_id = $3, mtime = now()
         WHERE workspace_id = $4 AND id = $5`,
        [newName, newLtree, destParent.id, this.workspaceId, srcNode.id],
      );

      if (srcNode.node_type === "directory") {
        await tx.query(
          `UPDATE fs_nodes
           SET path = ($1::ltree || subpath(path, nlevel($2::ltree)))
           WHERE workspace_id = $3
             AND path <@ $2::ltree
             AND path != $2::ltree`,
          [newLtree, oldLtree, this.workspaceId],
        );

        await tx.query(
          `UPDATE fs_nodes AS child
           SET parent_id = parent.id
           FROM fs_nodes AS parent
           WHERE child.workspace_id = $1
             AND parent.workspace_id = $1
             AND child.path <@ $2::ltree
             AND child.path != $2::ltree
             AND parent.path = subltree(child.path, 0, nlevel(child.path) - 1)`,
          [this.workspaceId, newLtree],
        );
      }
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new Error(
        `Invalid mode: ${mode} (must be integer between 0 and 4095/0o7777)`,
      );
    }
    return this.withWorkspace(async (tx) => {
      const p = normalizePath(path);
      const node = await this.resolveSymlinkMeta(tx, p);
      await tx.query(
        `UPDATE fs_nodes SET mode = $1 WHERE workspace_id = $2 AND id = $3`,
        [mode, this.workspaceId, node.id],
      );
    });
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    return this.withWorkspace(async (tx) => {
      const p = normalizePath(path);
      const node = await this.resolveSymlinkMeta(tx, p);
      await tx.query(
        `UPDATE fs_nodes SET mtime = $1 WHERE workspace_id = $2 AND id = $3`,
        [mtime, this.workspaceId, node.id],
      );
    });
  }

  // -- Public API: Links ------------------------------------------------------

  async symlink(target: string, linkPath: string): Promise<void> {
    return this.withWorkspace(async (tx) => {
      const p = normalizePath(linkPath);

      if (target.includes("\0")) {
        throw new Error("Paths cannot contain null bytes");
      }

      if (target.length > 4096) {
        throw new Error(
          "Symlink target exceeds maximum length of 4096 characters",
        );
      }

      const parentPosix = parentPath(p);
      const parent = await this.getNodeMeta(tx, parentPosix);
      if (!parent)
        throw new FsError(
          "ENOENT",
          "no such file or directory, symlink",
          linkPath,
        );

      this.validatePathDepth(this.resolveLinkTargetPath(p, target));

      const name = fileName(p);
      const lt = pathToLtree(p, this.workspaceId);
      const sizeBytes = new TextEncoder().encode(target).byteLength;

      await tx.query(
        `INSERT INTO fs_nodes (workspace_id, parent_id, name, node_type, path, symlink_target, mode, size_bytes)
         VALUES ($1, $2, $3, 'symlink', $4::ltree, $5, $6, $7)`,
        [this.workspaceId, parent.id, name, lt, target, 0o777, sizeBytes],
      );
    });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    return this.withWorkspace(async (tx) => {
      const src = normalizePath(existingPath);
      const srcNode = await this.getNode(tx, src);
      if (!srcNode)
        throw new FsError(
          "ENOENT",
          "no such file or directory, link",
          existingPath,
        );
      if (srcNode.node_type === "directory")
        throw new FsError(
          "EPERM",
          "operation not permitted, link",
          existingPath,
        );

      const content =
        srcNode.content !== null
          ? srcNode.content
          : srcNode.binary_data ?? new Uint8Array(0);
      await this.internalWriteFile(tx, normalizePath(newPath), content);
    });
  }

  async readlink(path: string): Promise<string> {
    return this.withWorkspace(async (tx) => {
      const p = normalizePath(path);
      const node = await this.getNodeMeta(tx, p);
      if (!node)
        throw new FsError(
          "ENOENT",
          "no such file or directory, readlink",
          path,
        );
      if (node.node_type !== "symlink")
        throw new FsError("EINVAL", "invalid argument, readlink", path);
      if (node.symlink_target === null) {
        throw new Error(
          `Corrupt symlink node at '${path}': symlink_target is null`,
        );
      }
      return node.symlink_target;
    });
  }

  // -- Public API: Utility ----------------------------------------------------

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    if (base === "/") return normalizePath("/" + path);
    return normalizePath(base + "/" + path);
  }

  // -- Public API: Search -----------------------------------------------------

  async textSearch(
    query: string,
    opts?: { path?: string; limit?: number },
  ): Promise<SearchResult[]> {
    return this.withWorkspace(async (tx) => {
      return fullTextSearch(tx, this.workspaceId, query, opts);
    });
  }

  async semanticSearch(
    query: string,
    opts?: { path?: string; limit?: number },
  ): Promise<SearchResult[]> {
    if (!this.embed) throw new Error("No embedding provider configured");
    const embedding = await this.embed(query);
    validateEmbedding(embedding, this.embeddingDimensions);
    return this.withWorkspace(async (tx) => {
      return semanticSearch(tx, this.workspaceId, embedding, opts);
    });
  }

  async hybridSearch(
    query: string,
    opts?: {
      path?: string;
      textWeight?: number;
      vectorWeight?: number;
      limit?: number;
    },
  ): Promise<SearchResult[]> {
    if (!this.embed) throw new Error("No embedding provider configured");
    const embedding = await this.embed(query);
    validateEmbedding(embedding, this.embeddingDimensions);
    return this.withWorkspace(async (tx) => {
      return hybridSearch(tx, this.workspaceId, query, embedding, opts);
    });
  }

  // -- Public API: Glob -------------------------------------------------------

  async glob(
    pattern: string,
    opts?: { cwd?: string },
  ): Promise<string[]> {
    const cwd = opts?.cwd ? normalizePath(opts.cwd) : "/";
    return this.withWorkspace(async (tx) => {
      const scopeLtree = pathToLtree(cwd, this.workspaceId);
      const result = await tx.query<{ path: string; name: string }>(
        `SELECT path::text, name FROM fs_nodes
         WHERE workspace_id = $1
           AND path <@ $2::ltree
           AND node_type = 'file'
         ORDER BY path`,
        [this.workspaceId, scopeLtree],
      );

      const regex = globToRegex(pattern);
      return result.rows
        .map((r) => ltreeToPath(r.path))
        .filter((p) => {
          const relative = cwd === "/" ? p : p.slice(cwd.length);
          return regex.test(relative);
        });
    });
  }

  async dispose(): Promise<void> {
    await this.withWorkspace(async (tx) => {
      const rootLtree = pathToLtree("/", this.workspaceId);
      await tx.query(
        `DELETE FROM fs_nodes WHERE workspace_id = $1 AND path <@ $2::ltree`,
        [this.workspaceId, rootLtree],
      );
    });
  }
}

function globToRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i += pattern[i + 2] === "/" ? 3 : 2;
    } else if (char === "*") {
      regex += "[^/]*";
      i++;
    } else if (char === "?") {
      regex += "[^/]";
      i++;
    } else if (char === "{") {
      const close = pattern.indexOf("}", i);
      if (close !== -1) {
        const options = pattern.slice(i + 1, close).split(",").map(escapeRegex).join("|");
        regex += `(?:${options})`;
        i = close + 1;
      } else {
        regex += escapeRegex(char);
        i++;
      }
    } else {
      regex += escapeRegex(char);
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
