import { cherryPick } from "./cherry-pick.js";
import {
  filesystemOpsContext,
  type FilesystemOpsContext,
  type FilesystemOpsHost,
} from "./context.js";
import { deleteVersion } from "./delete-version.js";
import { detach } from "./detach.js";
import { diff } from "./diff.js";
import { diffCount } from "./diff-count.js";
import { diffStream } from "./diff-stream.js";
import { fork } from "./fork.js";
import { getUsage } from "./get-usage.js";
import { listHistory } from "./list-history.js";
import { listVersions } from "./list-versions.js";
import { merge } from "./merge.js";
import { promoteTo } from "./promote-to.js";
import { renameVersion } from "./rename-version.js";
import { revert } from "./revert.js";
import { sweepHistory } from "./sweep-history.js";
import { versioned } from "./versioned.js";
import { versionDiff } from "./version-diff.js";
import { versionDiffStream } from "./version-diff-stream.js";

type DropContext<TOp> = TOp extends (
  ctx: infer _Ctx,
  ...args: infer TArgs
) => infer TResult
  ? (...args: TArgs) => TResult
  : never;

export interface FilesystemOpsApi<TFs> {
  getUsage: DropContext<typeof getUsage<TFs>>;
  versioned: DropContext<typeof versioned<TFs>>;
  diff: DropContext<typeof diff<TFs>>;
  diffCount: DropContext<typeof diffCount<TFs>>;
  diffStream: DropContext<typeof diffStream<TFs>>;
  fork: DropContext<typeof fork<TFs>>;
  detach: DropContext<typeof detach<TFs>>;
  listHistory: DropContext<typeof listHistory<TFs>>;
  listVersions: DropContext<typeof listVersions<TFs>>;
  deleteVersion: DropContext<typeof deleteVersion<TFs>>;
  renameVersion: DropContext<typeof renameVersion<TFs>>;
  promoteTo: DropContext<typeof promoteTo<TFs>>;
  merge: DropContext<typeof merge<TFs>>;
  cherryPick: DropContext<typeof cherryPick<TFs>>;
  revert: DropContext<typeof revert<TFs>>;
  sweepHistory: DropContext<typeof sweepHistory<TFs>>;
  versionDiff: DropContext<typeof versionDiff<TFs>>;
  versionDiffStream: DropContext<typeof versionDiffStream<TFs>>;
}

type FilesystemOperation<
  TFs,
  TArgs extends unknown[],
  TResult,
> = (ctx: FilesystemOpsContext<TFs>, ...args: TArgs) => TResult;

function bindFilesystemOp<
  TFs extends FilesystemOpsHost<TFs>,
  TArgs extends unknown[],
  TResult,
>(
  operation: FilesystemOperation<TFs, TArgs, TResult>,
): (this: TFs, ...args: TArgs) => TResult {
  return function boundFilesystemOp(this: TFs, ...args: TArgs): TResult {
    return operation(this[filesystemOpsContext](), ...args);
  };
}

function installOp<
  TFs extends FilesystemOpsHost<TFs> & FilesystemOpsApi<TFs>,
  TName extends keyof FilesystemOpsApi<TFs>,
  TArgs extends unknown[],
  TResult,
>(
  prototype: TFs,
  name: TName,
  operation: FilesystemOperation<TFs, TArgs, TResult>,
): void {
  const api = prototype as FilesystemOpsApi<TFs>;
  api[name] = bindFilesystemOp(
    operation,
  ) as unknown as FilesystemOpsApi<TFs>[TName];
}

export function installFilesystemOps<
  TFs extends FilesystemOpsHost<TFs> & FilesystemOpsApi<TFs>,
>(prototype: TFs): void {
  installOp(prototype, "getUsage", getUsage<TFs>);
  installOp(prototype, "versioned", versioned<TFs>);
  installOp(prototype, "diff", diff<TFs>);
  installOp(prototype, "diffCount", diffCount<TFs>);
  installOp(prototype, "diffStream", diffStream<TFs>);
  installOp(prototype, "fork", fork<TFs>);
  installOp(prototype, "detach", detach<TFs>);
  installOp(prototype, "listHistory", listHistory<TFs>);
  installOp(prototype, "listVersions", listVersions<TFs>);
  installOp(prototype, "deleteVersion", deleteVersion<TFs>);
  installOp(prototype, "renameVersion", renameVersion<TFs>);
  installOp(prototype, "promoteTo", promoteTo<TFs>);
  installOp(prototype, "merge", merge<TFs>);
  installOp(prototype, "cherryPick", cherryPick<TFs>);
  installOp(prototype, "revert", revert<TFs>);
  installOp(prototype, "sweepHistory", sweepHistory<TFs>);
  installOp(prototype, "versionDiff", versionDiff<TFs>);
  installOp(prototype, "versionDiffStream", versionDiffStream<TFs>);
}
