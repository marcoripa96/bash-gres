# bash-gres + Next.js Example

A web-based terminal that runs bash commands against a PostgreSQL-backed virtual filesystem.

## Setup

1. Start PostgreSQL (needs `ltree` and `pg_textsearch` extensions):

```sh
# From the repo root
docker compose up -d
```

2. Create the database:

```sh
createdb -h localhost -p 5432 -U postgres bashgres_example
```

3. Install dependencies and run:

```sh
cd examples/nextjs
npm install
npm run dev
```

4. Open http://localhost:3000 and try commands like:

```sh
mkdir docs
echo "hello world" > docs/readme.txt
ls -la
cat docs/readme.txt
tree
```

## Project structure

```
src/
  db/
    schema.ts          # Drizzle schema (notes table)
    index.ts           # postgres-js + Drizzle client singleton
app/
  layout.tsx           # Root layout
  page.tsx             # Terminal UI
  api/bash/route.ts    # POST /api/bash — executes commands
```

## How bash-gres is integrated

1. The Drizzle `db` instance is wrapped with `createDrizzleClient(db)` to produce a `SqlClient`
2. `setup(client)` creates the `fs_nodes` table idempotently on first request
3. `PgFileSystem` is created per-request with a workspace ID and passed to `new Bash({ fs })` from just-bash
4. The API route at `/api/bash` accepts `{ command: string }` and returns `{ exitCode, stdout, stderr }`
