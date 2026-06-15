import { FsError } from "../core/types.js";

/**
 * MountFs — a routing/overlay filesystem.
 *
 * `MountFs` implements the same structural `IFileSystem` interface that
 * `just-bash`'s `Bash` consumes and that `PgFileSystem` provides, but owns no
 * storage of its own. Instead it holds several backing filesystems, each
 * registered under a path prefix, and forwards every operation to whichever
 * backing fs owns the target path (longest matching prefix wins).
 *
 * This is the piece that turns several `rootDir`-scoped `PgFileSystem` views —
 * all pinned to the same workspace and version — into a single unified tree an
 * agent can `cd`/`cat`/`grep` across. Versioning is unaffected: the mounts are
 * pure read/write windows.
 *
 *   new MountFs([
 *     { prefix: "/home",          fs: homeFs },      // users/<id>, read-write
 *     { prefix: "/general",       fs: generalFs },   // read-only mount
 *     { prefix: "/clienti/acme",  fs: acmeFs },      // one mount per allowed client
 *   ])
 *
 * Behaviour notes:
 *
 *   - **Synthetic ancestors.** Nothing is mounted at `/` or `/clienti` above,
 *     yet `ls /` must list `home`, `general`, `clienti`. Those intermediate
 *     directories are synthesized from the mount table; they read as empty
 *     read-only directories that you cannot write into or remove.
 *   - **Cross-mount `mv`/`cp`.** A backing fs can only rename/copy within
 *     itself, so moving between mounts degrades to a read-through copy followed
 *     by a remove.
 *   - **Symlinks** are stored verbatim in the owning mount and resolved within
 *     that mount; a symlink whose target points into a *different* mount will
 *     not resolve across the boundary. Hard `link()` across mounts throws
 *     `EXDEV`, matching POSIX.
 */

export type BufferEncoding =
  | "utf8"
  | "utf-8"
  | "ascii"
  | "binary"
  | "base64"
  | "hex"
  | "latin1";

export type FileContent = string | Uint8Array;

export interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

export interface WriteFileOptions {
  encoding?: BufferEncoding;
}

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

export interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface CpOptions {
  recursive?: boolean;
}

/**
 * Structural filesystem interface — intentionally a local copy of the
 * `just-bash` `IFileSystem` shape so this module carries no hard dependency on
 * `just-bash` (mirrors how `PgFileSystem` only *structurally* implements it).
 */
export interface IFileSystem {
  readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void>;
  appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FsStat>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes?(path: string): Promise<DirentEntry[]>;
  rm(path: string, options?: RmOptions): Promise<void>;
  cp(src: string, dest: string, options?: CpOptions): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
  resolvePath(base: string, path: string): string;
  getAllPaths(): string[];
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  lstat(path: string): Promise<FsStat>;
  realpath(path: string): Promise<string>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}

export interface Mount {
  /** Absolute mount point, e.g. `/clienti/acme`. Normalized on construction. */
  prefix: string;
  /** Backing filesystem rooted at this mount point. */
  fs: IFileSystem;
}

interface RouteHit {
  mount: Mount;
  /** Path within the backing fs (always starts with `/`). */
  sub: string;
}

interface ErrorWithCode {
  code?: unknown;
}

/** Collapse `.`/`..`/duplicate slashes into a canonical absolute path. */
function normalize(p: string): string {
  if (!p || p === "/") return "/";
  const segs: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return "/" + segs.join("/");
}

/** Join a backing-fs sub-path back under its mount prefix (for realpath). */
function joinUnder(prefix: string, sub: string): string {
  const normalizedSub = normalize(sub);
  if (prefix === "/") return normalizedSub;
  if (normalizedSub === "/") return prefix;
  return normalize(prefix + normalizedSub);
}

/** Join a parent composite path with a single child name. */
function childPath(parent: string, name: string): string {
  return parent === "/" ? "/" + name : normalize(parent + "/" + name);
}

function parentPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

function hasErrorCode(error: unknown): error is ErrorWithCode {
  return typeof error === "object" && error !== null && "code" in error;
}

function errorCode(error: unknown): string | undefined {
  if (!hasErrorCode(error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function canUseSyntheticFallback(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function syntheticDirStat(): FsStat {
  return {
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    mode: 0o755,
    size: 0,
    mtime: new Date(0),
  };
}

export class MountFs implements IFileSystem {
  private readonly mounts: Mount[];
  private readonly mountByPrefix: Map<string, Mount>;
  private readonly syntheticChildrenByPath: Map<string, string[]>;

  constructor(mounts: Mount[]) {
    if (mounts.length === 0) {
      throw new Error("MountFs: at least one mount is required");
    }
    const seen = new Set<string>();
    const normalizedMounts = mounts.map((m) => {
      const prefix = normalize(m.prefix);
      if (seen.has(prefix)) {
        throw new Error(`MountFs: duplicate mount prefix '${prefix}'`);
      }
      seen.add(prefix);
      return { prefix, fs: m.fs };
    });

    this.mountByPrefix = new Map(normalizedMounts.map((m) => [m.prefix, m]));
    this.syntheticChildrenByPath = this.buildSyntheticChildren(normalizedMounts);
    this.mounts = normalizedMounts
      // Longest prefix first so the most specific mount wins.
      .sort((a, b) => b.prefix.length - a.prefix.length);
  }

  // -- Routing ----------------------------------------------------------------

  /** Deepest mount that owns `path`, or null when no mount does. */
  private route(path: string): RouteHit | null {
    const p = normalize(path);
    let prefix = p;
    while (true) {
      const mount = this.mountByPrefix.get(prefix);
      if (mount) {
        if (prefix === "/") return { mount, sub: p };
        return { mount, sub: p === prefix ? "/" : p.slice(prefix.length) };
      }
      if (prefix === "/") break;
      prefix = parentPath(prefix);
    }
    return null;
  }

  private buildSyntheticChildren(mounts: Mount[]): Map<string, string[]> {
    const children = new Map<string, Set<string>>();
    for (const mount of mounts) {
      if (mount.prefix === "/") continue;
      const segments = mount.prefix.slice(1).split("/");
      let parent = "/";
      for (const segment of segments) {
        let names = children.get(parent);
        if (!names) {
          names = new Set<string>();
          children.set(parent, names);
        }
        names.add(segment);
        parent = childPath(parent, segment);
      }
    }
    return new Map([...children].map(([path, names]) => [path, [...names]]));
  }

  /**
   * Names that exist purely because a mount lives strictly below `path`
   * (e.g. `clienti` under `/`, or `acme` under `/clienti`).
   */
  private syntheticChildren(path: string): string[] {
    const p = normalize(path);
    return this.syntheticChildrenByPath.get(p) ?? [];
  }

  private isSyntheticDir(path: string): boolean {
    return this.syntheticChildren(path).length > 0;
  }

  private err(code: string, op: string, path: string): FsError {
    return new FsError(code, op, normalize(path));
  }

  // -- File I/O ---------------------------------------------------------------

  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    const r = this.route(path);
    if (!r) {
      throw this.err(
        this.isSyntheticDir(path) ? "EISDIR" : "ENOENT",
        "no such file or directory, open",
        path,
      );
    }
    return r.mount.fs.readFile(r.sub, options);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const r = this.route(path);
    if (!r) {
      throw this.err(
        this.isSyntheticDir(path) ? "EISDIR" : "ENOENT",
        "no such file or directory, open",
        path,
      );
    }
    return r.mount.fs.readFileBuffer(r.sub);
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const r = this.route(path);
    if (!r) {
      throw this.err(
        this.isSyntheticDir(path) ? "EISDIR" : "ENOENT",
        "no such file or directory, open",
        path,
      );
    }
    return r.mount.fs.writeFile(r.sub, content, options);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const r = this.route(path);
    if (!r) {
      throw this.err(
        this.isSyntheticDir(path) ? "EISDIR" : "ENOENT",
        "no such file or directory, open",
        path,
      );
    }
    return r.mount.fs.appendFile(r.sub, content, options);
  }

  // -- Path queries -----------------------------------------------------------

  async exists(path: string): Promise<boolean> {
    const r = this.route(path);
    if (r) return r.mount.fs.exists(r.sub);
    return this.isSyntheticDir(path);
  }

  async stat(path: string): Promise<FsStat> {
    const r = this.route(path);
    if (r) return r.mount.fs.stat(r.sub);
    if (this.isSyntheticDir(path)) return syntheticDirStat();
    throw this.err("ENOENT", "no such file or directory, stat", path);
  }

  async lstat(path: string): Promise<FsStat> {
    const r = this.route(path);
    if (r) return r.mount.fs.lstat(r.sub);
    if (this.isSyntheticDir(path)) return syntheticDirStat();
    throw this.err("ENOENT", "no such file or directory, lstat", path);
  }

  async realpath(path: string): Promise<string> {
    const r = this.route(path);
    if (r) {
      const resolved = await r.mount.fs.realpath(r.sub);
      return joinUnder(r.mount.prefix, resolved);
    }
    if (this.isSyntheticDir(path)) return normalize(path);
    throw this.err("ENOENT", "no such file or directory, realpath", path);
  }

  // -- Directory operations ---------------------------------------------------

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const r = this.route(path);
    if (r) return r.mount.fs.mkdir(r.sub, options);
    if (this.isSyntheticDir(path)) {
      if (options?.recursive) return; // already exists logically
      throw this.err("EEXIST", "file already exists, mkdir", path);
    }
    throw this.err("ENOENT", "no such file or directory, mkdir", path);
  }

  async readdir(path: string): Promise<string[]> {
    const r = this.route(path);
    const extra = this.syntheticChildren(path);
    if (r) {
      let own: string[];
      try {
        own = await r.mount.fs.readdir(r.sub);
      } catch (e) {
        if (extra.length && canUseSyntheticFallback(e)) return extra;
        throw e;
      }
      return [...new Set([...own, ...extra])];
    }
    if (extra.length) return extra;
    throw this.err("ENOENT", "no such file or directory, scandir", path);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const r = this.route(path);
    const extra: DirentEntry[] = this.syntheticChildren(path).map((name) => ({
      name,
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
    }));
    if (r) {
      let own: DirentEntry[];
      try {
        own = await this.backingDirents(r.mount.fs, r.sub);
      } catch (e) {
        if (extra.length && canUseSyntheticFallback(e)) return extra;
        throw e;
      }
      const byName = new Map<string, DirentEntry>();
      for (const d of own) byName.set(d.name, d);
      // Mount points shadow same-named backing entries (they are directories).
      for (const d of extra) byName.set(d.name, d);
      return [...byName.values()];
    }
    if (extra.length) return extra;
    throw this.err("ENOENT", "no such file or directory, scandir", path);
  }

  private async backingDirents(
    fs: IFileSystem,
    sub: string,
  ): Promise<DirentEntry[]> {
    if (fs.readdirWithFileTypes) return fs.readdirWithFileTypes(sub);
    const names = await fs.readdir(sub);
    return Promise.all(
      names.map(async (name) => {
        const st = await fs.lstat(childPath(sub, name));
        return {
          name,
          isFile: st.isFile,
          isDirectory: st.isDirectory,
          isSymbolicLink: st.isSymbolicLink,
        };
      }),
    );
  }

  // -- Mutation ---------------------------------------------------------------

  async rm(path: string, options?: RmOptions): Promise<void> {
    const r = this.route(path);
    if (r) return r.mount.fs.rm(r.sub, options);
    if (this.isSyntheticDir(path)) {
      throw this.err("EACCES", "cannot remove mount point, rm", path);
    }
    if (options?.force) return; // rm -f on a missing path is silent
    throw this.err("ENOENT", "no such file or directory, rm", path);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const a = this.route(src);
    if (!a) {
      throw this.err(
        this.isSyntheticDir(src) ? "EISDIR" : "ENOENT",
        "no such file or directory, cp",
        src,
      );
    }
    const b = this.route(dest);
    if (!b) {
      throw this.err(
        this.isSyntheticDir(dest) ? "EISDIR" : "ENOENT",
        "no such file or directory, cp",
        dest,
      );
    }
    if (a.mount.fs === b.mount.fs) {
      return a.mount.fs.cp(a.sub, b.sub, options);
    }
    return this.crossCopy(src, dest, options?.recursive ?? false);
  }

  async mv(src: string, dest: string): Promise<void> {
    const a = this.route(src);
    if (!a) {
      throw this.err(
        this.isSyntheticDir(src) ? "EACCES" : "ENOENT",
        "no such file or directory, rename",
        src,
      );
    }
    const b = this.route(dest);
    if (!b) {
      throw this.err(
        this.isSyntheticDir(dest) ? "EISDIR" : "ENOENT",
        "no such file or directory, rename",
        dest,
      );
    }
    if (a.mount.fs === b.mount.fs) {
      return a.mount.fs.mv(a.sub, b.sub);
    }
    await this.crossCopy(src, dest, true);
    await this.rm(src, { recursive: true });
  }

  /** Recursive read-through copy across mounts, operating on composite paths. */
  private async crossCopy(
    src: string,
    dest: string,
    recursive: boolean,
  ): Promise<void> {
    const st = await this.lstat(src);
    if (st.isSymbolicLink) {
      const target = await this.readlink(src);
      await this.symlink(target, dest);
      return;
    }
    if (st.isDirectory) {
      if (!recursive) {
        throw this.err("EISDIR", "illegal operation on a directory, cp", src);
      }
      await this.mkdir(dest, { recursive: true });
      for (const name of await this.readdir(src)) {
        await this.crossCopy(childPath(src, name), childPath(dest, name), true);
      }
      return;
    }
    const buf = await this.readFileBuffer(src);
    await this.writeFile(dest, buf);
    try {
      await this.chmod(dest, st.mode);
    } catch {
      // Best-effort mode preservation; not all backends honour chmod.
    }
  }

  // -- Metadata & links -------------------------------------------------------

  async chmod(path: string, mode: number): Promise<void> {
    const r = this.route(path);
    if (r) return r.mount.fs.chmod(r.sub, mode);
    if (this.isSyntheticDir(path)) {
      throw this.err("EACCES", "cannot chmod mount point, chmod", path);
    }
    throw this.err("ENOENT", "no such file or directory, chmod", path);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const r = this.route(path);
    if (r) return r.mount.fs.utimes(r.sub, atime, mtime);
    if (this.isSyntheticDir(path)) {
      throw this.err("EACCES", "cannot utimes mount point, utimes", path);
    }
    throw this.err("ENOENT", "no such file or directory, utimes", path);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const r = this.route(linkPath);
    if (!r) {
      throw this.err(
        this.isSyntheticDir(linkPath) ? "EEXIST" : "ENOENT",
        "no such file or directory, symlink",
        linkPath,
      );
    }
    return r.mount.fs.symlink(target, r.sub);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const a = this.route(existingPath);
    if (!a) {
      throw this.err("ENOENT", "no such file or directory, link", existingPath);
    }
    const b = this.route(newPath);
    if (!b) {
      throw this.err(
        this.isSyntheticDir(newPath) ? "EEXIST" : "ENOENT",
        "no such file or directory, link",
        newPath,
      );
    }
    if (a.mount.fs !== b.mount.fs) {
      throw this.err("EXDEV", "cross-device link not permitted, link", newPath);
    }
    return a.mount.fs.link(a.sub, b.sub);
  }

  async readlink(path: string): Promise<string> {
    const r = this.route(path);
    if (!r) {
      throw this.err(
        this.isSyntheticDir(path) ? "EINVAL" : "ENOENT",
        "invalid argument, readlink",
        path,
      );
    }
    return r.mount.fs.readlink(r.sub);
  }

  // -- Utility ----------------------------------------------------------------

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalize(path);
    return normalize((base === "/" ? "/" : base + "/") + path);
  }

  getAllPaths(): string[] {
    const paths = new Set<string>();
    for (const [path, children] of this.syntheticChildrenByPath) {
      paths.add(path);
      for (const child of children) paths.add(childPath(path, child));
    }
    for (const mount of this.mounts) {
      paths.add(mount.prefix);
      for (const path of mount.fs.getAllPaths()) {
        paths.add(joinUnder(mount.prefix, path));
      }
    }
    return [...paths];
  }
}
