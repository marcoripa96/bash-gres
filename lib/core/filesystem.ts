import { randomUUID } from "crypto";
import type {
  SqlClient,
  PgFileSystemOptions,
  FsPermissions,
  FsAccess,
  FsStat,
  DirentEntry,
  DirentStatEntry,
  WalkEntry,
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

interface DirentStatRow {
  name: string;
  node_type: string;
  mode: number;
  size_bytes: number;
  mtime: Date;
  symlink_target: string | null;
}

interface WalkRow extends DirentStatRow {
  path: string;
  depth: number;
}

interface FsStatRow {
  node_type: string;
  symlink_target: string | null;
  mode: number;
  size_bytes: number;
  mtime: Date;
}

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
  private rootDir: string;
  private accessRead: string[] | null;
  private accessWrite: string[] | null;

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
    this.rootDir = normalizePath(options.rootDir ?? "/");

    if (options.access) {
      const write = (options.access.write ?? []).map((p) => normalizePath(p));
      const read = (options.access.read ?? []).map((p) => normalizePath(p));
      this.accessRead = [...read, ...write];
      this.accessWrite = write;
    } else {
      this.accessRead = null;
      this.accessWrite = null;
    }
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

      if (this.rootDir !== "/") {
        await this.internalMkdir(tx, this.rootDir, { recursive: true });
      }
    });
  }

  // -- Transaction wrapper (sets RLS context + timeout) -----------------------

  private withWorkspace<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) => {
      await tx.query(
        `SELECT
           set_config('app.workspace_id', $1, true),
           set_config('statement_timeout', $2, true)`,
        [this.workspaceId, String(this.statementTimeoutMs)],
      );
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

  private async getNodeStat(
    tx: SqlClient,
    posixPath: string,
  ): Promise<FsStatRow | null> {
    const lt = pathToLtree(posixPath, this.workspaceId);
    const result = await tx.query<FsStatRow>(
      `SELECT node_type, symlink_target, mode, size_bytes, mtime
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

  private async resolveSymlinkStat(
    tx: SqlClient,
    path: string,
    maxDepth = MAX_SYMLINK_DEPTH,
  ): Promise<FsStatRow> {
    const node = await this.getNodeStat(tx, path);
    if (!node) throw new FsError("ENOENT", "no such file or directory", path);
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0)
        throw new FsError("ELOOP", "too many levels of symbolic links", path);
      return this.resolveSymlinkStat(
        tx,
        this.resolveLinkTargetPath(path, node.symlink_target),
        maxDepth - 1,
      );
    }
    return node;
  }

  private resolveLinkTargetPath(linkPath: string, target: string): string {
    let resolved: string;
    if (target.startsWith("/")) {
      // Absolute symlink targets: resolve relative to rootDir to detect escapes
      // (e.g. /../../secret with rootDir=/jail → /jail/../../secret → /secret → outside)
      resolved = normalizePath(this.rootDir + "/" + target);
    } else {
      // Relative targets resolve from the link's parent (already internal)
      resolved = normalizePath(parentPath(linkPath) + "/" + target);
    }
    this.guardRootBoundary(resolved);
    return resolved;
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

  // -- Path translation & access guards ---------------------------------------

  private toInternalPath(userPath: string): string {
    const p = normalizePath(userPath);
    if (this.rootDir === "/") return p;
    return p === "/" ? this.rootDir : normalizePath(this.rootDir + p);
  }

  private toUserPath(internalPath: string): string {
    if (this.rootDir === "/") return internalPath;
    if (internalPath === this.rootDir) return "/";
    return internalPath.slice(this.rootDir.length);
  }

  private isAncestorOfAllowed(
    path: string,
    allowedPaths: string[],
  ): boolean {
    const prefix = path === "/" ? "/" : path + "/";
    return allowedPaths.some(
      (dir) => dir.startsWith(prefix) || dir === path,
    );
  }

  private guardRead(userPath: string): string {
    const p = normalizePath(userPath);
    if (this.accessRead !== null) {
      const allowed = this.accessRead.some(
        (dir) => dir === "/" || p === dir || p.startsWith(dir + "/"),
      );
      if (!allowed && !this.isAncestorOfAllowed(p, this.accessRead)) {
        throw new FsError("EACCES", "permission denied", userPath);
      }
    }
    return this.toInternalPath(p);
  }

  private guardWrite(userPath: string): string {
    const p = normalizePath(userPath);
    if (this.accessWrite !== null) {
      const allowed = this.accessWrite.some(
        (dir) => dir === "/" || p === dir || p.startsWith(dir + "/"),
      );
      if (!allowed) {
        throw new FsError("EACCES", "permission denied", userPath);
      }
    }
    return this.toInternalPath(p);
  }

  private syntheticReaddir(
    path: string,
    allowedPaths: string[],
  ): string[] {
    const prefix = path === "/" ? "/" : path + "/";
    const entries = new Set<string>();
    for (const dir of allowedPaths) {
      if (dir.startsWith(prefix)) {
        const rest = dir.slice(prefix.length);
        const firstSegment = rest.split("/")[0];
        if (firstSegment) entries.add(firstSegment);
      }
    }
    return [...entries].sort();
  }

  private syntheticReaddirWithTypes(
    path: string,
    allowedPaths: string[],
  ): DirentEntry[] {
    return this.syntheticReaddir(path, allowedPaths).map((name) => ({
      name,
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
    }));
  }

  private async syntheticReaddirWithStats(
    path: string,
    allowedPaths: string[],
  ): Promise<DirentStatEntry[]> {
    const names = this.syntheticReaddir(path, allowedPaths);
    if (names.length === 0) return [];

    const internal = this.toInternalPath(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.getNodeMeta(tx, internal);
      if (!node) {
        return names.map((name) => ({
          name,
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          mode: 0o755,
          size: 0,
          mtime: new Date(0),
          symlinkTarget: null,
        }));
      }

      const result = await tx.query<DirentStatRow>(
        `SELECT name, node_type, mode, size_bytes, mtime, symlink_target
         FROM fs_nodes
         WHERE workspace_id = $1 AND parent_id = $2 AND name = ANY($3::text[])
         ORDER BY name`,
        [this.workspaceId, node.id, names],
      );
      const rowMap = new Map(result.rows.map((row) => [row.name, row]));

      return names.map((name) => {
        const row = rowMap.get(name);
        if (!row) {
          return {
            name,
            isFile: false,
            isDirectory: true,
            isSymbolicLink: false,
            mode: 0o755,
            size: 0,
            mtime: new Date(0),
            symlinkTarget: null,
          };
        }
        return this.mapDirentStatRow(row);
      });
    });
  }

  private mapDirentStatRow(row: DirentStatRow): DirentStatEntry {
    return {
      name: row.name,
      isFile: row.node_type === "file",
      isDirectory: row.node_type === "directory",
      isSymbolicLink: row.node_type === "symlink",
      mode: row.mode,
      size: Number(row.size_bytes),
      mtime: new Date(row.mtime),
      symlinkTarget: row.symlink_target,
    };
  }

  private mapWalkRow(row: WalkRow): WalkEntry {
    return {
      path: this.toUserPath(ltreeToPath(row.path)),
      depth: Number(row.depth),
      ...this.mapDirentStatRow(row),
    };
  }

  private guardRootBoundary(internalPath: string): void {
    if (this.rootDir === "/") return;
    if (
      internalPath !== this.rootDir &&
      !internalPath.startsWith(this.rootDir + "/")
    ) {
      throw new FsError(
        "EACCES",
        "symlink target outside root boundary",
        this.toUserPath(internalPath),
      );
    }
  }

  private isPathReadable(userPath: string): boolean {
    if (this.accessRead === null) return true;
    return this.accessRead.some(
      (dir) => dir === "/" || userPath === dir || userPath.startsWith(dir + "/"),
    );
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
    const internal = this.guardRead(path);
    const hasRange = options?.offset !== undefined || options?.limit !== undefined;

    return this.withWorkspace(async (tx) => {
      if (hasRange) {
        const node = await this.resolveSymlinkMeta(tx, internal);
        if (node.node_type === "directory")
          throw new FsError("EISDIR", "illegal operation on a directory, read", path);

        const sqlOffset = (options?.offset ?? 0) + 1; // SQL SUBSTRING is 1-based
        const sqlLimit = options?.limit;

        const textExpr = sqlLimit !== undefined
          ? `substr(content, $3, $4)`
          : `substr(content, $3)`;
        const binaryExpr = sqlLimit !== undefined
          ? `substring(binary_data FROM $3 FOR $4)`
          : `substring(binary_data FROM $3)`;

        const params: (string | number)[] = [this.workspaceId, node.id, sqlOffset];
        if (sqlLimit !== undefined) params.push(sqlLimit);

        const result = await tx.query<{
          chunk_text: string | null;
          chunk_binary: Uint8Array | null;
        }>(
          `SELECT ${textExpr} AS chunk_text,
                  ${binaryExpr} AS chunk_binary
           FROM fs_nodes
           WHERE workspace_id = $1 AND id = $2
           LIMIT 1`,
          params,
        );

        const chunk = result.rows[0];
        if (!chunk) return "";
        if (chunk.chunk_text !== null) return chunk.chunk_text;
        if (chunk.chunk_binary !== null) {
          return new TextDecoder().decode(chunk.chunk_binary);
        }
        return "";
      }

      const node = await this.resolveSymlink(tx, internal);
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
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveSymlink(tx, internal);
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
    const internal = this.guardWrite(path);

    let embedding: number[] | null = null;
    if (typeof content === "string" && this.embed && content.length > 0) {
      embedding = await this.embed(content);
      if (embedding) validateEmbedding(embedding, this.embeddingDimensions);
    }

    return this.withWorkspace(async (tx) => {
      if (options?.recursive) {
        const parent = parentPath(internal);
        if (parent !== "/") {
          await this.internalMkdir(tx, parent, { recursive: true });
        }
      }
      await this.internalWriteFile(tx, internal, content, embedding);
    });
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const internal = this.guardWrite(path);
    return this.withWorkspace(async (tx) => {
      const existing = await this.getNodeForUpdate(tx, internal);

      if (!existing) {
        await this.internalWriteFile(tx, internal, content);
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
        await this.internalWriteFile(tx, internal, merged);
      } else {
        await this.internalWriteFile(tx, internal, (existing.content ?? "") + content);
      }
    });
  }

  // -- Public API: Path queries -----------------------------------------------

  async exists(path: string): Promise<boolean> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const lt = pathToLtree(internal, this.workspaceId);
      const result = await tx.query<{ exists: number }>(
        `SELECT 1 AS exists
         FROM fs_nodes
         WHERE workspace_id = $1 AND path = $2::ltree
         LIMIT 1`,
        [this.workspaceId, lt],
      );
      return result.rows.length > 0;
    });
  }

  async stat(path: string): Promise<FsStat> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveSymlinkStat(tx, internal);
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
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.getNodeStat(tx, internal);
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
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const resolved = await this.internalRealpath(tx, internal);
      return this.toUserPath(resolved);
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
    const internal = this.guardWrite(path);
    return this.withWorkspace(async (tx) => {
      await this.internalMkdir(tx, internal, options);
    });
  }

  async readdir(path: string): Promise<string[]> {
    const p = normalizePath(path);

    if (this.accessRead !== null) {
      const directlyAllowed = this.accessRead.some(
        (dir) => dir === "/" || p === dir || p.startsWith(dir + "/"),
      );
      if (!directlyAllowed) {
        if (this.isAncestorOfAllowed(p, this.accessRead) || p === "/") {
          return this.syntheticReaddir(p, this.accessRead);
        }
        throw new FsError("EACCES", "permission denied", path);
      }
    }

    const internal = this.toInternalPath(p);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveSymlinkMeta(tx, internal);
      if (node.node_type !== "directory") {
        throw new FsError("ENOTDIR", "not a directory, scandir", path);
      }

      const result = await tx.query<{ name: string }>(
        `SELECT name FROM fs_nodes
         WHERE workspace_id = $1 AND parent_id = $2
         ORDER BY name`,
        [this.workspaceId, node.id],
      );
      return result.rows.map((row) => row.name);
    });
  }

  async readdirWithTypes(path: string): Promise<DirentEntry[]> {
    const p = normalizePath(path);

    if (this.accessRead !== null) {
      const directlyAllowed = this.accessRead.some(
        (dir) => dir === "/" || p === dir || p.startsWith(dir + "/"),
      );
      if (!directlyAllowed) {
        if (this.isAncestorOfAllowed(p, this.accessRead) || p === "/") {
          return this.syntheticReaddirWithTypes(p, this.accessRead);
        }
        throw new FsError("EACCES", "permission denied", path);
      }
    }

    const internal = this.toInternalPath(p);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveSymlinkMeta(tx, internal);
      if (!node)
        throw new FsError(
          "ENOENT",
          "no such file or directory, scandir",
          path,
        );
      if (node.node_type !== "directory")
        throw new FsError("ENOTDIR", "not a directory, scandir", path);

      const result = await tx.query<{ name: string; node_type: string }>(
        `SELECT name, node_type
         FROM fs_nodes
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

  async readdirWithStats(path: string): Promise<DirentStatEntry[]> {
    const p = normalizePath(path);

    if (this.accessRead !== null) {
      const directlyAllowed = this.accessRead.some(
        (dir) => dir === "/" || p === dir || p.startsWith(dir + "/"),
      );
      if (!directlyAllowed) {
        if (this.isAncestorOfAllowed(p, this.accessRead) || p === "/") {
          return this.syntheticReaddirWithStats(p, this.accessRead);
        }
        throw new FsError("EACCES", "permission denied", path);
      }
    }

    const internal = this.toInternalPath(p);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveSymlinkMeta(tx, internal);
      if (node.node_type !== "directory") {
        throw new FsError("ENOTDIR", "not a directory, scandir", path);
      }

      const result = await tx.query<DirentStatRow>(
        `SELECT name, node_type, mode, size_bytes, mtime, symlink_target
         FROM fs_nodes
         WHERE workspace_id = $1 AND parent_id = $2
         ORDER BY name`,
        [this.workspaceId, node.id],
      );
      return result.rows.map((row) => this.mapDirentStatRow(row));
    });
  }

  async walk(path: string): Promise<WalkEntry[]> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveSymlinkMeta(tx, internal);
      if (node.node_type !== "directory") {
        throw new FsError("ENOTDIR", "not a directory, scandir", path);
      }

      const rootPath = ltreeToPath(node.path);
      const rootLtree = pathToLtree(rootPath, this.workspaceId);
      const result = await tx.query<WalkRow>(
        `SELECT path::text, name, node_type, mode, size_bytes, mtime, symlink_target,
                nlevel(path) - nlevel($2::ltree) AS depth
         FROM fs_nodes
         WHERE workspace_id = $1
           AND path <@ $2::ltree
           AND path != $2::ltree
         ORDER BY path`,
        [this.workspaceId, rootLtree],
      );

      return result.rows
        .map((row) => this.mapWalkRow(row))
        .filter((entry) => this.isPathReadable(entry.path));
    });
  }

  // -- Public API: Mutation ---------------------------------------------------

  async rm(path: string, options?: RmOptions): Promise<void> {
    const internal = this.guardWrite(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.getNodeMeta(tx, internal);

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
        const lt = pathToLtree(internal, this.workspaceId);
        const subtree = await tx.query<{ id: number; depth: number }>(
          `SELECT id, nlevel(path) AS depth
           FROM fs_nodes
           WHERE workspace_id = $1 AND path <@ $2::ltree
           ORDER BY depth DESC, path DESC`,
          [this.workspaceId, lt],
        );

        let currentDepth: number | null = null;
        let idsAtDepth: number[] = [];
        for (const row of subtree.rows) {
          if (currentDepth === null) {
            currentDepth = row.depth;
          }

          if (row.depth !== currentDepth) {
            await tx.query(
              `DELETE FROM fs_nodes
               WHERE workspace_id = $1 AND id = ANY($2::int[])`,
              [this.workspaceId, idsAtDepth],
            );
            idsAtDepth = [];
            currentDepth = row.depth;
          }

          idsAtDepth.push(row.id);
        }

        if (idsAtDepth.length > 0) {
          await tx.query(
            `DELETE FROM fs_nodes
             WHERE workspace_id = $1 AND id = ANY($2::int[])`,
            [this.workspaceId, idsAtDepth],
          );
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
    const srcInternal = this.guardRead(src);
    const destInternal = this.guardWrite(dest);
    return this.withWorkspace(async (tx) => {
      await this.internalCp(tx, srcInternal, destInternal, options);
    });
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcInternal = this.guardWrite(src);
    const destInternal = this.guardWrite(dest);
    return this.withWorkspace(async (tx) => {
      const srcPath = srcInternal;
      const destPath = destInternal;

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
    const internal = this.guardWrite(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveSymlinkMeta(tx, internal);
      await tx.query(
        `UPDATE fs_nodes SET mode = $1 WHERE workspace_id = $2 AND id = $3`,
        [mode, this.workspaceId, node.id],
      );
    });
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    const internal = this.guardWrite(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.resolveSymlinkMeta(tx, internal);
      await tx.query(
        `UPDATE fs_nodes SET mtime = $1 WHERE workspace_id = $2 AND id = $3`,
        [mtime, this.workspaceId, node.id],
      );
    });
  }

  // -- Public API: Links ------------------------------------------------------

  async symlink(target: string, linkPath: string): Promise<void> {
    const internal = this.guardWrite(linkPath);

    if (target.includes("\0")) {
      throw new Error("Paths cannot contain null bytes");
    }

    if (target.length > 4096) {
      throw new Error(
        "Symlink target exceeds maximum length of 4096 characters",
      );
    }

    return this.withWorkspace(async (tx) => {
      const parentPosix = parentPath(internal);
      const parent = await this.getNodeMeta(tx, parentPosix);
      if (!parent)
        throw new FsError(
          "ENOENT",
          "no such file or directory, symlink",
          linkPath,
        );

      const resolvedTarget = this.resolveLinkTargetPath(internal, target);
      this.validatePathDepth(resolvedTarget);
      this.guardRootBoundary(resolvedTarget);

      const name = fileName(internal);
      const lt = pathToLtree(internal, this.workspaceId);
      const sizeBytes = new TextEncoder().encode(target).byteLength;

      await tx.query(
        `INSERT INTO fs_nodes (workspace_id, parent_id, name, node_type, path, symlink_target, mode, size_bytes)
         VALUES ($1, $2, $3, 'symlink', $4::ltree, $5, $6, $7)`,
        [this.workspaceId, parent.id, name, lt, target, 0o777, sizeBytes],
      );
    });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const srcInternal = this.guardRead(existingPath);
    const destInternal = this.guardWrite(newPath);
    return this.withWorkspace(async (tx) => {
      const srcNode = await this.getNode(tx, srcInternal);
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
      await this.internalWriteFile(tx, destInternal, content);
    });
  }

  async readlink(path: string): Promise<string> {
    const internal = this.guardRead(path);
    return this.withWorkspace(async (tx) => {
      const node = await this.getNodeStat(tx, internal);
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
    const scopePath = opts?.path ? normalizePath(opts.path) : "/";
    this.guardRead(scopePath);
    const internalScope = this.toInternalPath(scopePath);
    return this.withWorkspace(async (tx) => {
      const results = await fullTextSearch(tx, this.workspaceId, query, {
        ...opts,
        path: internalScope,
      });
      return results
        .map((r) => ({ ...r, path: this.toUserPath(r.path) }))
        .filter((r) => this.isPathReadable(r.path));
    });
  }

  async semanticSearch(
    query: string,
    opts?: { path?: string; limit?: number },
  ): Promise<SearchResult[]> {
    if (!this.embed) throw new Error("No embedding provider configured");
    const scopePath = opts?.path ? normalizePath(opts.path) : "/";
    this.guardRead(scopePath);
    const internalScope = this.toInternalPath(scopePath);
    const embedding = await this.embed(query);
    validateEmbedding(embedding, this.embeddingDimensions);
    return this.withWorkspace(async (tx) => {
      const results = await semanticSearch(tx, this.workspaceId, embedding, {
        ...opts,
        path: internalScope,
      });
      return results
        .map((r) => ({ ...r, path: this.toUserPath(r.path) }))
        .filter((r) => this.isPathReadable(r.path));
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
    const scopePath = opts?.path ? normalizePath(opts.path) : "/";
    this.guardRead(scopePath);
    const internalScope = this.toInternalPath(scopePath);
    const embedding = await this.embed(query);
    validateEmbedding(embedding, this.embeddingDimensions);
    return this.withWorkspace(async (tx) => {
      const results = await hybridSearch(tx, this.workspaceId, query, embedding, {
        ...opts,
        path: internalScope,
      });
      return results
        .map((r) => ({ ...r, path: this.toUserPath(r.path) }))
        .filter((r) => this.isPathReadable(r.path));
    });
  }

  // -- Public API: Glob -------------------------------------------------------

  async glob(
    pattern: string,
    opts?: { cwd?: string },
  ): Promise<string[]> {
    const userCwd = opts?.cwd ? normalizePath(opts.cwd) : "/";
    this.guardRead(userCwd);
    const literalPrefix = globLiteralPrefix(pattern);
    const queryScope = literalPrefix
      ? normalizePath(userCwd === "/" ? `/${literalPrefix}` : `${userCwd}/${literalPrefix}`)
      : userCwd;
    const internalScope = this.toInternalPath(queryScope);
    const queryPlan = analyzeGlobPattern(pattern, literalPrefix);
    return this.withWorkspace(async (tx) => {
      const scopeLtree = pathToLtree(internalScope, this.workspaceId);
      const where = [
        `workspace_id = $1`,
        queryPlan.exact ? `path = $2::ltree` : `path <@ $2::ltree`,
        `node_type = 'file'`,
      ];
      const params: (string | number)[] = [this.workspaceId, scopeLtree];

      if (!queryPlan.exact && queryPlan.fixedDepth !== null) {
        where.push(`nlevel(path) = nlevel($2::ltree) + ${queryPlan.fixedDepth}`);
      }

      if (queryPlan.basename !== null) {
        where.push(`name = $${params.length + 1}`);
        params.push(queryPlan.basename);
      }

      const result = await tx.query<{ path: string }>(
        `SELECT path::text FROM fs_nodes
         WHERE ${where.join("\n           AND ")}
         ORDER BY path`,
        params,
      );

      const regex = globToRegex(pattern);
      return result.rows
        .map((r) => ltreeToPath(r.path))
        .map((p) => this.toUserPath(p))
        .filter((p) => {
          if (!this.isPathReadable(p)) return false;
          const relative = userCwd === "/" ? p.slice(1) : p.slice(userCwd.length + 1);
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

function injectWorkspaceSettings(text: string): string {
  const trimmed = text.trimStart();
  const leading = text.slice(0, text.length - trimmed.length);
  const shifted = shiftSqlParams(trimmed, 2);
  const settingsCte =
    "_bash_gres_settings AS (SELECT set_config('app.workspace_id', $1, true), set_config('statement_timeout', $2, true))";

  if (/^WITH\b/i.test(trimmed)) {
    return `${leading}WITH ${settingsCte}, ${shifted.slice(5)}`;
  }

  return `${leading}WITH ${settingsCte} ${shifted}`;
}

function shiftSqlParams(text: string, offset: number): string {
  return text.replace(/\$(\d+)/g, (_match, index) => `$${Number(index) + offset}`);
}

function globLiteralPrefix(pattern: string): string | null {
  const segments = pattern.split("/");
  const prefix: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") break;
    if (/[?*{]/.test(segment)) break;
    prefix.push(segment);
  }

  return prefix.length > 0 ? prefix.join("/") : null;
}

function analyzeGlobPattern(
  pattern: string,
  literalPrefix: string | null,
): {
  exact: boolean;
  fixedDepth: number | null;
  basename: string | null;
} {
  const relative = stripGlobLiteralPrefix(pattern, literalPrefix);
  if (relative === "") {
    return { exact: true, fixedDepth: 0, basename: null };
  }

  const segments = relative.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? null;
  return {
    exact: false,
    fixedDepth: segments.includes("**") ? null : segments.length,
    basename:
      basename !== null && !/[?*{]/.test(basename)
        ? basename
        : null,
  };
}

function stripGlobLiteralPrefix(
  pattern: string,
  literalPrefix: string | null,
): string {
  if (!literalPrefix) return pattern;
  const prefixSegments = literalPrefix.split("/").filter(Boolean).length;
  return pattern.split("/").slice(prefixSegments).join("/");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
