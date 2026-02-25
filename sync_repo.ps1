<#
.SYNOPSIS
    Syncs the local Seaweed Dashboard repo with GitHub.
.DESCRIPTION
    1. Stashes any uncommitted local changes
    2. Pulls the latest data from GitHub (including hourly Action commits)
    3. Restores local changes on top
    4. Optionally commits + pushes local changes upstream

    The GitHub Action (download-data.yml) runs every hour and commits fresh
    ThingSpeak data to origin/main.  Running this script pulls those data
    commits to your local drive so you always have a local backup that
    matches the web dashboard.

    Run this on-demand whenever you want to freshen local data or push
    code changes.  No schedule is set - you trigger it yourself.
.PARAMETER Push
    If set, commits any staged/unstaged changes and pushes to origin.
    Without this flag the script only pulls (safe read-only sync).
.PARAMETER CommitMessage
    Custom commit message when -Push is used.
    Default: "local: sync <timestamp>"
.EXAMPLE
    # Pull latest data only (no push)
    .\sync_repo.ps1

    # Pull latest data AND push local changes
    .\sync_repo.ps1 -Push

    # Pull + push with a custom message
    .\sync_repo.ps1 -Push -CommitMessage "Dashboard template unified"
#>

param(
    [switch]$Push,
    [string]$CommitMessage = ""
)

# Use Continue so git stderr (info messages) doesn't terminate the script.
# We check $LASTEXITCODE manually after every git call.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

# -------------------------------------------------------------------
# HELPERS
# -------------------------------------------------------------------

function Write-Step  { param([string]$msg) Write-Host "`n> $msg" -ForegroundColor Cyan }
function Write-OK    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }
function Write-Info  { param([string]$msg) Write-Host "  $msg" -ForegroundColor Gray }

# Check that git is available
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Err "git is not in PATH.  Install Git for Windows first."
    exit 1
}

# -------------------------------------------------------------------
# PRE-FLIGHT: show current state
# -------------------------------------------------------------------

Write-Host ""
Write-Host "===============================================" -ForegroundColor DarkCyan
Write-Host "  Seaweed Dashboard -- Repo Sync" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor DarkCyan

$branch = (git branch --show-current 2>$null).Trim()
if (-not $branch) { $branch = "main" }
Write-Info "Branch : $branch"
Write-Info "Remote : $(git remote get-url origin 2>$null)"
Write-Info "Mode   : $(if ($Push) { 'Pull + Push' } else { 'Pull only (read-only)' })"

# -------------------------------------------------------------------
# STEP 1: Stash uncommitted changes (if any)
# -------------------------------------------------------------------

Write-Step "Checking for uncommitted changes..."

$dirty = (git status --porcelain 2>$null)
$didStash = $false

if ($dirty) {
    $changeCount = ($dirty | Measure-Object).Count
    Write-Warn "$changeCount uncommitted change(s) -- stashing before pull"

    git stash push -m "sync_repo auto-stash $(Get-Date -Format 'yyyy-MM-dd HH:mm')" --include-untracked 2>&1 | Out-Null
    $didStash = $true
    Write-OK "Changes stashed"
} else {
    Write-OK "Working tree clean"
}

# -------------------------------------------------------------------
# STEP 2: Fetch + pull from origin
# -------------------------------------------------------------------

Write-Step "Fetching from origin..."

$fetchOut = git fetch origin 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Err "Fetch failed -- are you online?"
    Write-Info ($fetchOut -join "`n")
    if ($didStash) { git stash pop 2>&1 | Out-Null }
    exit 1
}
Write-OK "Fetch complete"

# Count how many commits we're behind
$behind = 0
try {
    $behind = [int](git rev-list --count "HEAD..origin/$branch" 2>$null)
} catch { $behind = 0 }

if ($behind -eq 0) {
    Write-OK "Already up-to-date with origin/$branch"
} else {
    Write-Step "Pulling $behind new commit(s) from origin/$branch..."

    # Use rebase to keep a linear history (avoids merge commits from the Action's hourly pushes)
    $pullOut = git pull --rebase origin $branch 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Pull failed -- possible conflict"
        Write-Info ($pullOut -join "`n")
        Write-Warn "Attempting to resolve data/ conflicts by keeping remote version..."

        # For data files, always prefer remote (the Action has the latest ThingSpeak data)
        $conflicted = git diff --name-only --diff-filter=U 2>$null
        $allResolved = $true
        foreach ($f in $conflicted) {
            if ($f -like "data/*") {
                git checkout --theirs -- $f 2>$null
                git add $f 2>$null
                Write-Info "  Resolved (kept remote): $f"
            } else {
                $allResolved = $false
                Write-Warn "  CONFLICT (needs manual resolve): $f"
            }
        }

        if ($allResolved) {
            git rebase --continue 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-OK "Conflicts auto-resolved -- rebase complete"
            } else {
                Write-Err "Rebase still failing -- run 'git rebase --abort' and resolve manually"
                if ($didStash) { Write-Warn "Your stashed changes are safe -- run 'git stash pop' after resolving" }
                exit 1
            }
        } else {
            Write-Err "Non-data conflicts need manual resolution."
            Write-Warn "After resolving, run:  git rebase --continue"
            if ($didStash) { Write-Warn "Your stashed changes are safe -- run 'git stash pop' after resolving" }
            exit 1
        }
    } else {
        Write-OK "Pulled $behind commit(s) successfully"
    }
}

# -------------------------------------------------------------------
# STEP 3: Restore stashed changes
# -------------------------------------------------------------------

if ($didStash) {
    Write-Step "Restoring stashed changes..."

    $popOut = git stash pop 2>&1
    if ($LASTEXITCODE -ne 0) {
        # Stash pop can conflict if remote updated the same data files
        Write-Warn "Stash pop had conflicts -- resolving data/ files with remote version"

        $conflicted = git diff --name-only --diff-filter=U 2>$null
        foreach ($f in $conflicted) {
            if ($f -like "data/*") {
                # Remote data is newer (from the Action), keep it
                git checkout --theirs -- $f 2>$null
                git add $f 2>$null
                Write-Info "  Kept remote version: $f"
            } else {
                Write-Warn "  CONFLICT (needs manual resolve): $f"
            }
        }
        # Reset the stash-merge state
        git reset HEAD 2>&1 | Out-Null
        Write-OK "Stash restored (data conflicts auto-resolved)"
    } else {
        Write-OK "Stashed changes restored"
    }
}

# -------------------------------------------------------------------
# STEP 4: Summary of data freshness
# -------------------------------------------------------------------

Write-Step "Data freshness check..."

$dataFolders = @("data_3262071_TT", "data_WROOM_PTT", "data_Shangani", "data_Funzi")
foreach ($df in $dataFolders) {
    $mergedPath = Join-Path (Join-Path "data" $df) "merged_data.js"
    if (Test-Path $mergedPath) {
        $lastWrite = (Get-Item $mergedPath).LastWriteTime
        $age = [math]::Round(((Get-Date) - $lastWrite).TotalHours, 1)
        $color = if ($age -lt 2) { "Green" } elseif ($age -lt 24) { "Yellow" } else { "Red" }
        $label = $df.PadRight(20)
        $ts    = $lastWrite.ToString('dd-MMM HH:mm')
        Write-Host "  ${label} merged_data.js -- ${ts} (${age}h ago)" -ForegroundColor $color
    } else {
        $label = $df.PadRight(20)
        Write-Host "  ${label} (no data)" -ForegroundColor DarkGray
    }
}

# -------------------------------------------------------------------
# STEP 5: Push (optional)
# -------------------------------------------------------------------

if ($Push) {
    Write-Step "Staging and pushing changes..."

    git add -A 2>&1 | Out-Null

    $staged = git diff --staged --stat 2>$null
    if (-not $staged) {
        Write-OK "Nothing to commit -- working tree matches remote"
    } else {
        if (-not $CommitMessage) {
            $CommitMessage = "local: sync $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
        }

        git commit -m $CommitMessage 2>&1 | Out-Null
        Write-OK "Committed: $CommitMessage"

        $pushOut = git push origin $branch 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Push failed"
            Write-Info ($pushOut -join "`n")
            exit 1
        }
        Write-OK "Pushed to origin/$branch"
    }
}

# -------------------------------------------------------------------
# DONE
# -------------------------------------------------------------------

Write-Host ""
Write-Host "===============================================" -ForegroundColor DarkCyan
if ($Push) {
    Write-Host "  Sync complete (pull + push)" -ForegroundColor Green
} else {
    Write-Host "  Sync complete (pull only)" -ForegroundColor Green
    Write-Host "  Run with -Push to also commit & push changes" -ForegroundColor DarkGray
}
Write-Host "===============================================" -ForegroundColor DarkCyan
Write-Host ""
