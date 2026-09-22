#!/bin/sh
# Deploys the built app (dist/) to the uberspace host via scp.
# Reads DEPLOY_HOST and DEPLOY_PATH from a git-ignored .env in the repo root.
# Run via `npm run deploy` (which builds first) or directly once dist/ exists.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_file="$repo_root/.env"
dist_dir="$repo_root/dist"

if [ ! -f "$env_file" ]; then
    echo "deploy.sh: $env_file not found. Copy .env.example to .env and fill in DEPLOY_HOST / DEPLOY_PATH." >&2
    exit 1
fi

# shellcheck disable=SC1090
. "$env_file"

if [ -z "${DEPLOY_HOST:-}" ] || [ -z "${DEPLOY_PATH:-}" ]; then
    echo "deploy.sh: DEPLOY_HOST and/or DEPLOY_PATH not set in $env_file." >&2
    exit 1
fi

if [ ! -d "$dist_dir" ]; then
    echo "deploy.sh: $dist_dir not found. Run 'npm run build' first (or use 'npm run deploy')." >&2
    exit 1
fi

if [ ! -f "$dist_dir/.htaccess" ]; then
    echo "deploy.sh: $dist_dir/.htaccess not found; expected vite to copy public/.htaccess into dist/." >&2
    exit 1
fi

echo "deploy.sh: deploying $dist_dir/ to $DEPLOY_HOST:$DEPLOY_PATH/"

if command -v rsync >/dev/null 2>&1; then
    # rsync copies dotfiles like .htaccess without special-casing.
    rsync -az --delete "$dist_dir/" "$DEPLOY_HOST:$DEPLOY_PATH/"
else
    # Plain `scp -r dist/.` can silently skip dotfiles on some scp
    # implementations, so copy visible files and .htaccess explicitly.
    scp -r "$dist_dir"/* "$dist_dir/.htaccess" "$DEPLOY_HOST:$DEPLOY_PATH/"
fi

echo "deploy.sh: done."
