-- Coach can freeze the automatic accessory rotation for an athlete (e.g. ACL
-- rehab: the plan must be followed exactly, no surprise exercise changes).
-- Lives on users so it survives skeleton regens and profile rewrites.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS exercise_rotation_locked BOOLEAN NOT NULL DEFAULT FALSE;
