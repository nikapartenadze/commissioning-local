# Sync Validation Checklist

## IO Durability

1. Disconnect internet.
2. Spam one IO with `Fail`, `Clear`, comment edit, `Pass`.
3. Verify local UI and local history update immediately.
4. Reconnect internet.
5. Verify cloud receives the final ordered IO history without local loss.

## L2 Recovery

1. Disconnect internet.
2. Change the same L2 cell several times quickly.
3. Verify the latest local value remains visible after refresh/restart.
4. Reconnect internet.
5. Verify cloud converges to the latest intended value.

## Pull Protection

1. Create pending local IO or L2 sync rows while offline.
2. Attempt cloud pull.
3. Verify pull is blocked and no local rows are overwritten.

## Crash Recovery

1. Create pending local IO and L2 rows while offline.
2. Kill the local server process.
3. Restart the server.
4. Verify pending counts still exist and the queue resumes retrying after connectivity returns.
