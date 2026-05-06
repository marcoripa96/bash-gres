export {
  createPrismaClient,
  setup,
  PgFileSystem,
} from "./adapter.js";
export type {
  PrismaLike,
  PrismaClientOptions,
  PrismaPgFileSystemOptions,
} from "./adapter.js";
export { FsQuotaError } from "../../core/types.js";
export type { WorkspaceUsage, WorkspaceUsageOptions } from "../../core/types.js";
