# GitHub & Render Deployment Workflow

## Overview

This document outlines the exact workflow for pushing code changes to GitHub and auto-deploying to Render.

**Key Principle:** Code changes → GitHub (`main` branch) → Render auto-deploys

---

## Setup (One-Time Only)

### 1. Git Configuration

```bash
git config user.name "Claude"
git config user.email "mike@chriscollinsinc.com"
```

### 2. GitHub Personal Access Token (PAT)

**Token:** Stored securely in `/mnt/project/GitHub_Personal_Access_Token`

**Used for:** Cloning and pushing without manual authentication (in `/mnt/project/` directory only)

**Note:** PAT is sensitive — never commit it to the repository. GitHub's secret scanning will block the push if detected.

### 3. Repository Info

- **Remote URL:** `https://github.com/chriscollinsinc/coach-fulfillment-system.git`
- **Branch:** `main` (auto-deploys to Render)
- **Organization:** `chriscollinsinc`
- **Local Path:** `/home/claude/coach-fulfillment-system/`

---

## Development Workflow

### Step 1: Make Code Changes

Edit files in `/home/claude/coach-fulfillment-system/`:
- `db.js` — Database migrations and schema
- `server.js` — Backend API endpoints
- `public/app.js` — Frontend code

### Step 2: Syntax Verification (Critical!)

Before committing, ALWAYS verify syntax:

```bash
cd /home/claude/coach-fulfillment-system

# Check backend
node -c server.js

# Check database
node -c db.js

# Check frontend
node -c public/app.js

# Check all three at once
node -c db.js && node -c server.js && node -c public/app.js && echo "✅ All checks passed!"
```

**If any file fails:** Fix the error BEFORE proceeding to commit.

### Step 3: Review Changes (git diff)

See exactly what changed:

```bash
git diff public/app.js
```

Output shows:
- Lines with `-` = removed
- Lines with `+` = added
- Context lines (unchanged) for reference

**Best practice:** Review the diff carefully to catch unintended changes.

### Step 4: Stage Changes

Add specific files to the commit:

```bash
# Add one file
git add public/app.js

# Add multiple files
git add db.js server.js public/app.js

# Add all changes (use with caution)
git add -A
```

### Step 5: Commit

Create a meaningful commit message:

```bash
git commit -m "Phase 1: Database schema - add visit notes columns and coaching_calls table"
```

**Commit message format:**
- Clear, descriptive
- First line: brief (under 72 chars)
- Optional additional lines for details

**Examples:**
```
git commit -m "Add Assigned Coach column to LID Inventory table"
git commit -m "Fix: remove duplicate Save buttons, allow coaches to save notes on assigned clients' visits"
git commit -m "Phase 3: Frontend - coaching notes modal with history sidebar and CRUD functions"
```

### Step 6: Push to GitHub

Push the commit to the remote `main` branch:

```bash
git push origin main
```

Expected output:
```
To https://github.com/chriscollinsinc/coach-fulfillment-system.git
   fdd38f9..48fa9f6  main -> main
```

This shows:
- Previous commit hash: `fdd38f9`
- New commit hash: `48fa9f6`
- Branch: `main`

---

## Auto-Deployment on Render

### What Happens After Push

1. **GitHub receives push** → Webhook triggers
2. **Render detects change** → Automatically pulls from `main`
3. **Render runs build** → Installs dependencies, runs migrations
4. **Render deploys** → App goes live at `https://coach-fulfillment-system.onrender.com`

### Deployment Time

- Typical: 2-5 minutes from push to live
- Check status at: `https://dashboard.render.com`

### Verify Deployment

After pushing:

```bash
# Check git log to confirm commit was pushed
git log --oneline | head -5

# Expected output:
# 48fa9f6 (HEAD -> main, origin/main) Phase 3: Frontend - coaching notes modal
# fdd38f9 (origin/main) Fix table cell alignment: render cells using INV_COLS
# ...
```

### Live Verification

1. Visit app: `https://coach-fulfillment-system.onrender.com`
2. Refresh browser (hard refresh: Cmd+Shift+R or Ctrl+Shift+R)
3. Test the new feature
4. Check browser console for any errors (F12 → Console tab)

---

## Troubleshooting

### Issue: "fatal: could not read Username"

**Cause:** Git authentication failed

**Fix:** Clone using PAT in URL:
```bash
cd /tmp
# Use PAT from /mnt/project/GitHub_Personal_Access_Token
PAT=$(cat /mnt/project/GitHub_Personal_Access_Token)
git clone https://$PAT@github.com/chriscollinsinc/coach-fulfillment-system.git
cd coach-fulfillment-system
```

### Issue: "syntax error in app.js" after commit

**Cause:** Didn't run `node -c public/app.js` before committing

**Fix:** 
1. Fix the syntax error in the file
2. Run `node -c public/app.js` to verify
3. Stage and commit: `git add public/app.js && git commit -m "Fix syntax error in app.js"`
4. Push: `git push origin main`

### Issue: Render shows old version after push

**Cause:** Browser cache or slow deployment

**Fix:**
1. Hard refresh browser: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)
2. Wait 5 minutes for Render to finish deploying
3. Check Render dashboard for build status

### Issue: "git push rejected"

**Cause:** Merge conflict or permission issue

**Fix:**
```bash
# Pull latest changes first
git pull origin main

# Resolve any conflicts (will show in editor)
# Then try push again
git push origin main
```

---

## Complete Workflow Example

Here's a full end-to-end example:

```bash
# 1. Navigate to repo
cd /home/claude/coach-fulfillment-system

# 2. Make changes to app.js
# (edit file in editor)

# 3. Verify syntax
node -c public/app.js
# ✅ Output: (no errors)

# 4. Review changes
git diff public/app.js
# Shows additions/removals

# 5. Stage changes
git add public/app.js

# 6. Commit
git commit -m "Add Coaching Notes button to client profile"

# 7. Push to GitHub
git push origin main
# Output: To https://github.com/chriscollinsinc/coach-fulfillment-system.git
#         2fc7565..a1b2c3d  main -> main

# 8. Verify in logs
git log --oneline | head -1
# a1b2c3d (HEAD -> main) Add Coaching Notes button to client profile

# 9. Wait 2-5 minutes for Render deployment

# 10. Test live at https://coach-fulfillment-system.onrender.com
```

---

## Important Notes

### Branch Strategy

- **`main`** = production (auto-deploys to Render)
- **No other branches** in use currently
- Always commit to `main`

### Commit Frequency

- Commit after each logical unit of work
- Smaller, frequent commits are better than huge ones
- Each commit should be deployable

### Before Every Push

Checklist:
- [ ] Syntax check: `node -c db.js && node -c server.js && node -c public/app.js`
- [ ] Review diff: `git diff`
- [ ] Meaningful commit message
- [ ] No accidental file changes
- [ ] No console.log or debug code (unless intentional)

### Rollback (if needed)

If a deployment breaks things:

```bash
# View commit history
git log --oneline | head -10

# Reset to previous commit (e.g., a1b2c3d)
git reset --hard a1b2c3d

# Force push to GitHub (careful!)
git push origin main --force

# Render will auto-deploy the previous version
```

---

## Render Configuration

**Auto-Deploy:** Enabled on `main` branch push

**Build Command:** (Default Node.js)
- Installs dependencies: `npm install`
- Runs migrations: `node db.js` (at startup)

**Start Command:** 
- `node server.js`

**Environment Variables:**
- `DB_PATH` = `/opt/render/project/src/data` (persistent disk)
- `PORT` = `3000` (or assigned by Render)

**Persistent Disk:**
- Mounted at `/opt/render/project/src/data`
- Database file lives here
- Survives redeploys and restarts

---

## URLs Reference

- **App:** `https://coach-fulfillment-system.onrender.com`
- **GitHub Repo:** `https://github.com/chriscollinsinc/coach-fulfillment-system`
- **Render Dashboard:** `https://dashboard.render.com`
- **Local:** `/home/claude/coach-fulfillment-system`

---

## Summary: The 6-Step Process

Every deployment follows this pattern:

1. **Edit** code in `/home/claude/coach-fulfillment-system/`
2. **Check** syntax: `node -c file.js`
3. **Review** changes: `git diff`
4. **Commit** to Git: `git add . && git commit -m "message"`
5. **Push** to GitHub: `git push origin main`
6. **Wait** 2-5 minutes for Render to auto-deploy

**That's it!** The app is then live.

---

**Last Updated:** September 11, 2026  
**Author:** Claude (working with Mike)  
**Status:** Tested and verified
