ALTER TABLE fs_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fs_nodes FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'fs_nodes' AND policyname = 'workspace_isolation'
    ) THEN
        CREATE POLICY workspace_isolation ON fs_nodes FOR ALL
            USING (workspace_id = current_setting('app.workspace_id', true))
            WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
    END IF;
END $$;
