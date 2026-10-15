#!/usr/bin/env bash
# Release without downtime: push the tag first, wait until CI has published the image to
# GHCR, and only then push main. ArgoCD deploys appVersion from main right away and the
# chart uses the Recreate strategy, so pushing main before the image exists takes the old
# pod down and leaves the new one in ImagePullBackOff for the whole build (~10 min).
#
# Usage: scripts/release.sh X.Y.Z
# Precondition: HEAD on main is the release commit (CHANGELOG, package.json,
# package-lock.json and helm/Chart.yaml already say X.Y.Z), not yet pushed.
set -euo pipefail

ver=${1:?usage: scripts/release.sh X.Y.Z}
[[ $ver =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version: $ver" >&2; exit 2; }
tag="v$ver"
image="ghcr.io/stufently/gpt-web-gateway:$ver"
cd "$(git rev-parse --show-toplevel)"

die() { echo "release: $*" >&2; exit 1; }

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "not on main"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean"
git fetch -q origin main --tags
git merge-base --is-ancestor origin/main HEAD || die "HEAD does not contain origin/main — pull first"
[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] || die "nothing to release: HEAD is already on origin/main"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists"

grep -qE "^appVersion: \"?$ver\"?$" helm/Chart.yaml || die "helm/Chart.yaml appVersion is not $ver"
grep -qE "^version: $ver$" helm/Chart.yaml || die "helm/Chart.yaml version is not $ver"
[ "$(jq -r .version package.json)" = "$ver" ] || die "package.json version is not $ver"
[ "$(jq -r .version package-lock.json)" = "$ver" ] || die "package-lock.json version is not $ver"
grep -qE "^## $ver( |$)" CHANGELOG.md || die "CHANGELOG.md has no '## $ver' section"

sha=$(git rev-parse HEAD)
git tag "$tag" "$sha"
git push origin "$tag"

echo "waiting for the CI run of $tag ..."
run_id=""
for _ in $(seq 1 60); do
  run_id=$(gh run list --workflow ci.yml --commit "$sha" --event push --json databaseId,headBranch \
    --jq ".[] | select(.headBranch == \"$tag\") | .databaseId" | head -1)
  [ -n "$run_id" ] && break
  sleep 5
done
[ -n "$run_id" ] || die "no CI run for $tag appeared; main NOT pushed"
gh run watch "$run_id" --exit-status --interval 20 >/dev/null || die "CI run $run_id failed; main NOT pushed"

docker manifest inspect "$image" >/dev/null || die "$image is not in the registry; main NOT pushed"
echo "image $image is published"

git push origin main
echo "released $tag: ArgoCD will now roll out an image that already exists"
