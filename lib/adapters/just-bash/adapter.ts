import type { IFileSystem, FsStat } from "just-bash";
import type { DirentEntry } from "../../core/types.js";
import { PgFileSystem } from "../../core/filesystem.js";
import { normalizePath, parentPath } from "../../core/path-encoding.js";

/**
 * Wraps a PgFileSystem instance to implement the just-bash IFileSystem interface.
 *
 * Usage:
 * ```ts
 * import { PostgresFileSystem } from "bash-gres/just-bash";
 * import { Bash } from "just-bash";
 *
 * const fs = new PostgresFileSystem(pgFs);
 * const bash = new Bash({ fs });
 * ```
 */
export class PostgresFileSystem implements IFileSystem {
  constructor(private readonly fs: PgFileSystem) {}

  async readFile(
    path: string,
    _options?: { encoding?: string | null } | string,
  ): Promise<string> {
    return this.fs.readFile(path);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.fs.readFileBuffer(path);
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    _options?: { encoding?: string } | string,
  ): Promise<void> {
    return this.fs.writeFile(path, content, { recursive: true });
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    _options?: { encoding?: string } | string,
  ): Promise<void> {
    const parent = parentPath(normalizePath(path));
    if (parent !== "/") {
      await this.fs.mkdir(parent, { recursive: true });
    }
    return this.fs.appendFile(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.fs.exists(path);
  }

  async stat(path: string): Promise<FsStat> {
    return this.fs.stat(path);
  }

  async lstat(path: string): Promise<FsStat> {
    return this.fs.lstat(path);
  }

  async realpath(path: string): Promise<string> {
    return this.fs.realpath(path);
  }

  resolvePath(base: string, path: string): string {
    return this.fs.resolvePath(base, path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.fs.mkdir(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    return this.fs.readdir(path);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return this.fs.readdirWithTypes(path);
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    return this.fs.rm(path, options);
  }

  async cp(
    src: string,
    dest: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    return this.fs.cp(src, dest, options);
  }

  async mv(src: string, dest: string): Promise<void> {
    return this.fs.mv(src, dest);
  }

  async chmod(path: string, mode: number): Promise<void> {
    return this.fs.chmod(path, mode);
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    return this.fs.utimes(path, _atime, mtime);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    return this.fs.symlink(target, linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    return this.fs.link(existingPath, newPath);
  }

  async readlink(path: string): Promise<string> {
    return this.fs.readlink(path);
  }

  getAllPaths(): string[] {
    // Synchronous enumeration is not feasible for a database-backed filesystem.
    // just-bash uses this for glob matching; returning [] is explicitly allowed
    // by the interface ("implementations may return empty array if not supported").
    return [];
  }
}

