# Sync Contract

## IO

- Local SQLite is authoritative first.
- Every pass, fail, clear, and comment change is written locally before cloud sync.
- IO sync is history-sensitive: ordered pending rows are drained oldest-first per IO.
- Cloud pull must not overwrite IOs with unsynced local rows.

## L2

- Local SQLite is authoritative first.
- L2 sync is latest-value convergence, not full edit history replay.
- Rapid edits on the same cell may coalesce to the latest saved local value before cloud acknowledgement.
- Cloud pull must not overwrite L2 cells while local L2 queue rows are pending.

## Operational Rule

- Manual or background pull is blocked whenever local IO, L2, or change-request queues are dirty.
- Config, database, backups, and logs resolve from the same storage root.
