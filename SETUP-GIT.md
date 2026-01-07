# Git Setup Guide

## The Problem

Your folder was downloaded as a ZIP file (from GitHub's "Download ZIP" option) or extracted without the `.git` folder, so it's not connected to the repository.

## Solution: Re-initialize Git Repository

### Step 1: Initialize Git

```powershell
cd "C:\Users\nfart\Downloads\io-checkout-development-main\io-checkout-development"
git init
```

This creates a new `.git` folder and initializes the repository.

### Step 2: Add Remote Origin

Replace `YOUR_REPO_URL` with your actual repository URL:

```powershell
# If you know the repository URL (e.g., from GitHub/GitLab/Bitbucket)
git remote add origin YOUR_REPO_URL

# Example:
# git remote add origin https://github.com/yourusername/io-checkout-development.git
# or
# git remote add origin git@github.com:yourusername/io-checkout-development.git
```

### Step 3: Verify Remote

```powershell
git remote -v
```

You should see:
```
origin  YOUR_REPO_URL (fetch)
origin  YOUR_REPO_URL (push)
```

### Step 4: Create .gitignore (Important!)

Before committing, create a `.gitignore` file to exclude build artifacts and dependencies:

```powershell
# Create .gitignore file
@"
# .NET
bin/
obj/
*.user
*.suo
*.cache
*.dll
*.exe
*.pdb

# Node.js
node_modules/
.next/
out/
build/
dist/

# Database
*.db
*.db-shm
*.db-wal

# IDE
.vs/
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
logs/

# Environment
.env
.env.local
.env.production

# Portable Distribution (optional - uncomment if you don't want to track it)
# IO-Checkout-Tool-Portable/
"@ | Out-File -FilePath .gitignore -Encoding utf8
```

### Step 5: Stage and Commit Files

```powershell
# Add all files (respecting .gitignore)
git add .

# Create initial commit
git commit -m "Initial commit: IO Checkout Tool"
```

### Step 6: Set Default Branch (Optional)

If you want to use `main` instead of `master`:

```powershell
git branch -M main
```

### Step 7: Push to Remote (First Time)

```powershell
# Push and set upstream
git push -u origin main

# Or if using master branch:
# git push -u origin master
```

---

## If You Want to Clone Instead

If the repository already exists remotely and you want a fresh clone with full git history:

```powershell
# Navigate to parent directory
cd "C:\Users\nfart\Downloads"

# Rename current folder (backup)
Rename-Item "io-checkout-development-main" "io-checkout-development-main-backup"

# Clone the repository
git clone YOUR_REPO_URL io-checkout-development-main

# Navigate into it
cd io-checkout-development-main
```

This gives you the full git history and automatic remote connection.

---

## Common Git Commands

### Check Status
```powershell
git status
```

### Pull Latest Changes
```powershell
git pull origin main
```

### Commit Changes
```powershell
git add .
git commit -m "Your commit message"
git push origin main
```

### Create New Branch
```powershell
git checkout -b feature/new-feature
```

### Switch Branches
```powershell
git checkout main
```

### View Commit History
```powershell
git log --oneline
```

---

## Troubleshooting

### "fatal: not a git repository"
- Run `git init` in the project root

### "fatal: remote origin already exists"
- Remove it: `git remote remove origin`
- Add again: `git remote add origin YOUR_REPO_URL`

### "Permission denied (publickey)"
- You need to set up SSH keys or use HTTPS with credentials
- For HTTPS: `git remote set-url origin https://github.com/user/repo.git`
- For SSH: Set up SSH keys in GitHub/GitLab settings

### "refusing to merge unrelated histories"
- If pulling from existing repo: `git pull origin main --allow-unrelated-histories`

---

## Quick Setup Script

Copy and paste this entire block (update YOUR_REPO_URL):

```powershell
cd "C:\Users\nfart\Downloads\io-checkout-development-main\io-checkout-development"

# Initialize git
git init

# Add remote (CHANGE THIS URL!)
git remote add origin YOUR_REPO_URL

# Create .gitignore
@"
bin/
obj/
node_modules/
.next/
*.db
*.db-shm
*.db-wal
.vs/
.vscode/
*.log
.env
.env.local
"@ | Out-File -FilePath .gitignore -Encoding utf8

# Stage and commit
git add .
git commit -m "Initial commit: IO Checkout Tool"

# Set branch to main
git branch -M main

# Push to remote
git push -u origin main
```

---

**Note**: If you don't know your repository URL, check:
- GitHub: Go to your repo → Click "Code" button → Copy URL
- GitLab: Go to your repo → Click "Clone" → Copy URL
- Bitbucket: Go to your repo → Click "Clone" → Copy URL

