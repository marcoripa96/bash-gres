import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as notes from "./schema/notes";
import * as fsNodes from "./schema/fs-nodes";

const schema = { ...notes, ...fsNodes };

const globalForDb = globalThis as unknown as {
  pgClient: ReturnType<typeof postgres> | undefined;
};

const queryClient =
  globalForDb.pgClient ?? postgres(process.env.DATABASE_URL!);

if (process.env.NODE_ENV !== "production") {
  globalForDb.pgClient = queryClient;
}

export const db = drizzle({ client: queryClient, schema });
