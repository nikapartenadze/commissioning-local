# Security — secrets handling

## Rules (enforced)

1. **Never commit secrets.** No `.env`, `appsettings*.json`, `.jwt-secret`,
   `*battle-dev-config*.json`, `*dev-config-mcm*.json`, `*.pem/.key/.pfx`.
   These are git-ignored. Commit a `*.env.example` with placeholders instead.
2. **Local guard.** A `pre-commit` hook blocks secret files and secret-looking
   values. Enable it once per clone:
   ```sh
   git config core.hooksPath .githooks
   ```
   (Install `gitleaks` for the strongest scan; a regex fallback runs without it.)
3. **Server guard (can't be bypassed).** GitLab CI job `gitleaks-scan` and the
   GitHub `gitleaks` workflow scan every push. `--no-verify` skips the *local*
   hook but not these.
4. **Config lives in the environment / secret store**, not in the repo:
   - CI: GitLab/GitHub **masked CI/CD variables** (e.g. `CLOUD_API_KEY`).
   - Runtime: `.env` files on the host (git-ignored) or the deployment secret store.

## If a secret is committed or leaks

Removing it from git history does **NOT** make it safe — assume anything ever
pushed is compromised.

1. **ROTATE it first** (the only real fix): issue a new value, update every
   consumer (app config, CI variables, host `.env`), retire the old one.
2. Purge it from history with `git filter-repo` (see the runbook below), then
   force-push **both** remotes (`gitlab` and `origin`).
3. Tell anyone with a clone to re-clone (rewritten history changes every SHA).

## History purge runbook (what was done 2026-07-09)

```sh
# backup all refs first
git bundle create ../PRE-PURGE.bundle --all

# strip the secret files from every commit + redact stray copies of the values
git filter-repo \
  --paths-from-file purge-paths.txt --invert-paths \
  --replace-text purge-secrets.txt --force

# filter-repo drops remotes as a safety measure — re-add them
git remote add gitlab https://gitlab.lci.ge/commissioning/commissioning-local.git
git remote add origin git@github-work:nikapartenadze/commissioning-local.git

git push --force --all gitlab && git push --force --tags gitlab
git push --force --all origin && git push --force --tags origin
```

## Secrets that were exposed and need rotation (2026-07-09 purge)

Purged from history, but were pushed to GitLab **and** GitHub, so treat as
compromised until rotated:

| Secret | Where it lived | Action |
|---|---|---|
| Azure Postgres password (`Sharpness6069`) | old `.env` (DATABASE_URL) | **Rotate** — shared prod DB; coordinate across all apps |
| Azure AD client secret | old `.env` | **Rotate** in the Azure portal |
| NextAuth secret | old `.env` | Rotate if not already done |
| ASP.NET JWT SecretKey | `backend/appsettings.json` | Rotate; invalidates issued tool tokens |
| io-checkout JWT secret + `.jwt-secret` | portable build | Rotate |
| Field sync `ApiPassword` (`battle-*`) | `battle-dev-config.json`, CI | Rotate the project's cloud API key |
