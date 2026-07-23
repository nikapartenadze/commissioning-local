-- Seed for the belt-untrack end-to-end test (throwaway local cloud DB only).
-- Idempotent: deletes the fixed-id rows first, then re-inserts. Safe to re-run.
--
-- Fixed ids (well above any autoincrement the throwaway DB will reach):
--   project 9001, subsystem 9002 (name MCM15), template 9003, sheet 9004 (VFD),
--   columns 9010-9013, device 9020, cells 9030-9032.
--   access key: plaintext "proj_9001_belttest", role Mechanical.
--
-- The Belt Tracked cell is deliberately NOT seeded — the real mechanic toggle
-- CREATES it (version 1) on TRACK and UPDATES it (version 2, value '') on UNTRACK,
-- which is exactly the cloud-owned clear the field pull must honour.

BEGIN;

-- Clean up prior run (children first via FK cascade from the parents we delete).
DELETE FROM l2_cell_values WHERE device_id = 9020;
DELETE FROM l2_devices     WHERE id = 9020;
DELETE FROM l2_columns     WHERE sheet_id = 9004;
DELETE FROM l2_sheets      WHERE id = 9004;
DELETE FROM l2_templates   WHERE id = 9003;
DELETE FROM access_key_projects WHERE access_key_id = 9005;
DELETE FROM project_access_keys WHERE id = 9005;
DELETE FROM subsystem_change_log WHERE subsystem_id = 9002;
DELETE FROM subsystems     WHERE id = 9002;
DELETE FROM projects       WHERE id = 9001;

INSERT INTO projects (id, name, api_key, archived)
VALUES (9001, 'E2E Belt Untrack', 'e2e-belt-key', false);

INSERT INTO subsystems (id, project_id, name)
VALUES (9002, 9001, 'MCM15');

-- Mechanical access key. The key_hash is a bcrypt hash of the plaintext
-- 'proj_9001_belttest', computed by the test at runtime (bcryptjs, compatible
-- with the cloud's bcryptjs.compare) and substituted for __KEYHASH__ before this
-- script is piped to psql — so no hash literal is committed to the repo.
INSERT INTO project_access_keys
  (id, project_id, key_hash, key_prefix, label, role, is_active, usage_count, created_at)
VALUES
  (9005, 9001, '__KEYHASH__',
   'proj_9001_', 'E2E Mechanic', 'Mechanical', true, 0, now());

INSERT INTO l2_templates (id, project_id, name, imported_at, version)
VALUES (9003, 9001, 'E2E VFD Template', now(), 1);

INSERT INTO l2_sheets (id, template_id, name, display_name, display_order, discipline, device_count)
VALUES (9004, 9003, 'VFD', 'VFD Commissioning', 1, 'E', 1);

INSERT INTO l2_columns
  (id, sheet_id, name, column_type, input_type, display_order, is_system, is_editable, include_in_progress, is_required)
VALUES
  (9010, 9004, 'Verify Identity',  'check', 'pass_fail', 1, false, true, true,  false),
  (9011, 9004, 'Motor HP (Field)', 'data',  'number',    2, false, true, false, false),
  (9012, 9004, 'VFD HP (Field)',   'data',  'number',    3, false, true, false, false),
  (9013, 9004, 'Belt Tracked',     'check', 'pass_fail', 4, false, true, false, false);

-- Device is MCM-keyed on "MCM15"; its `subsystem` tag is a human label
-- ("Bypass VS-B") that does NOT match any subsystem name — proving the toggle
-- resolves the field cursor from `mcm`, not the descriptive label.
INSERT INTO l2_devices
  (id, sheet_id, device_name, mcm, subsystem, display_order, completed_checks, total_checks)
VALUES
  (9020, 9004, 'UL15_3_VFD1', 'MCM15', 'Bypass VS-B', 1, 0, 0);

-- Wizard progress (identity + HP done) so the writer asserts Valid_Map/Valid_HP
-- alongside Tracking_Finished; Belt Tracked is left to the real toggle.
INSERT INTO l2_cell_values (id, device_id, column_id, value, updated_by, updated_at, version)
VALUES
  (9030, 9020, 9010, 'OK', 'seed', now(), 1),
  (9031, 9020, 9011, '5',  'seed', now(), 1),
  (9032, 9020, 9012, '5',  'seed', now(), 1);

COMMIT;
