#!/usr/bin/env bash
# Builds the release artifact that install.sh consumes, and proves what is in it.
#
# The frozen reference tree must never reach a user's machine as runtime code,
# so the artifact is assembled from an explicit allowlist and then INSPECTED —
# a packaging mistake should fail here, not on someone's laptop.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"
OUT="${1:-dist-release}"
NAME="zeus-${VERSION}"
STAGE="$OUT/$NAME"

rm -rf "$OUT"; mkdir -p "$STAGE"
if command -v npm >/dev/null 2>&1 && [ -d node_modules ]; then npm run --silent build; fi
[ -d dist ] || { echo "package: dist/ missing — build first" >&2; exit 1; }

for item in bin dist src install.sh README.md package.json LICENSE; do
  [ -e "$item" ] && cp -a "$item" "$STAGE/"
done

# Assertions: what must not be there.
fail=0
for forbidden in internal reference tools legacy .zeus .autopilot state worktrees node_modules .git; do
  if [ -e "$STAGE/$forbidden" ]; then echo "package: FORBIDDEN $forbidden is in the artifact" >&2; fail=1; fi
done
if grep -rIlE "BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}" "$STAGE" 2>/dev/null | head -1 | grep -q .; then
  echo "package: FORBIDDEN credential-shaped content in the artifact" >&2; fail=1
fi
# Optional: scan for identifiers from earlier, unrelated work. The list lives
# OUTSIDE this repository — writing the strings down here would reintroduce
# exactly what the check exists to keep out. Point ZEUS_BOUNDARY_RULES at a
# private JSON file to enable it.
if [ -n "${ZEUS_BOUNDARY_RULES:-}" ] && [ -f "$ZEUS_BOUNDARY_RULES" ]; then
  while IFS= read -r ident; do
    [ -n "$ident" ] || continue
    if grep -rIliF "$ident" "$STAGE" 2>/dev/null | head -1 | grep -q .; then
      echo "package: artifact contains a forbidden historical identifier" >&2; fail=1
    fi
  done < <(node -p "require(process.env.ZEUS_BOUNDARY_RULES).identifiers.join('\n')")
fi
# Stale product branding must not reach a user. The migration and
# compatibility code names the old identity deliberately, so those files are
# named here instead of loosening the check.
brand_allow="src/migrate.ts|dist/migrate.js|bin/autopilot|README.md|src/config.ts|dist/config.js|src/cli.ts|dist/cli.js|install.sh"
stale="$(grep -rIliE "ai-autopilot|AI Autopilot" "$STAGE" 2>/dev/null \
  | sed "s|^$STAGE/||" | grep -vE "^($brand_allow)$" || true)"
if [ -n "$stale" ]; then
  echo "package: stale product branding in the artifact:" >&2
  printf '  %s\n' $stale >&2
  fail=1
fi
[ "$fail" -eq 0 ] || exit 1

tar czf "$OUT/${NAME}.tar.gz" -C "$OUT" "$NAME"
( cd "$OUT" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256" 2>/dev/null || shasum -a 256 "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256" )
echo "artifact: $OUT/${NAME}.tar.gz"
echo "sha256:   $(cut -d' ' -f1 < "$OUT/${NAME}.tar.gz.sha256")"
echo "contents: $(tar tzf "$OUT/${NAME}.tar.gz" | wc -l) entries"
