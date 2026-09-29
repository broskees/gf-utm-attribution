#!/usr/bin/env bash
# Usage: bin/build-release.sh <version>
# Builds dist/gf-utm-attribution.zip, refusing if <version> is not the plugin's Version header.
set -euo pipefail

requested_version="${1:?Usage: bin/build-release.sh <version>}"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
header_version="$(sed -n 's/^ \* Version: *\([^ ]*\) *$/\1/p' "$repo_root/plugin/plugin.php")"

if [ "$requested_version" != "$header_version" ]; then
    echo "Version $requested_version does not match the Version header in plugin/plugin.php ($header_version)." >&2
    exit 1
fi

staging_dir="$(mktemp -d)"
trap 'rm -rf "$staging_dir"' EXIT

mkdir "$staging_dir/gf-utm-attribution"
cp "$repo_root/plugin/plugin.php" "$repo_root/plugin/utm-capture.js" "$staging_dir/gf-utm-attribution/"

mkdir -p "$repo_root/dist"
rm -f "$repo_root/dist/gf-utm-attribution.zip"
(cd "$staging_dir" && zip -r -X -q "$repo_root/dist/gf-utm-attribution.zip" gf-utm-attribution)

echo "Built dist/gf-utm-attribution.zip ($requested_version)"
