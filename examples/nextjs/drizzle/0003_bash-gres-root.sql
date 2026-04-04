INSERT INTO fs_nodes (workspace_id, name, node_type, path, mode)
VALUES ('demo', '/', 'directory', 'w_demo'::ltree, 493)
ON CONFLICT (workspace_id, path) DO NOTHING;
