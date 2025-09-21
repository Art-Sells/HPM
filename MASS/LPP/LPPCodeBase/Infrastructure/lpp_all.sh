#!/usr/bin/env bash
set -euo pipefail

echo "▶️  LPP mass-rename starting (UniswapV3→LPP; V3→LPP; uniswapV3*→lpp*)"

# Detect dirs (supports Protocol/Periphery or lowercase)
PROT=$(ls -d protocol Protocol 2>/dev/null | head -n1 || true)
PERF=$(ls -d periphery Periphery 2>/dev/null | head -n1 || true)
[[ -n "$PROT" && -n "$PERF" && -d "$PROT" && -d "$PERF" ]] || { echo "❌ Can't find protocol+periphery here"; pwd; ls -la; exit 1; }

# Count BEFORE
echo "— Counts BEFORE —"
grep -RInE "UniswapV3|(^|[^A-Za-z])V3([^A-Za-z]|$)|uniswapV3" "$PROT" "$PERF" --include='*.sol' --include='*.ts' --include='*.js' --include='*.md' --include='*.json' --include='*.yml' --include='*.yaml' | wc -l | xargs echo "Matches:"

# Helper: safe mv (git-aware)
safe_mv () {
  local src="$1" dst="$2"
  [[ "$src" == "$dst" ]] && return 0
  mkdir -p "$(dirname "$dst")"
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git mv -f "$src" "$dst" 2>/dev/null || mv -f "$src" "$dst"
  else
    mv -f "$src" "$dst"
  fi
  echo "mv: $src -> $dst"
}

# ---------- PATH RENAMES (ORDER MATTERS) ----------
for ROOT in "$PROT" "$PERF"; do
  # A) UniswapV3* → LPP*
  find "$ROOT" -depth -name '*UniswapV3*' -print0 | \
  xargs -0 -I{} bash -c 'f="{}"; nf="${f//UniswapV3/LPP}"; [[ "$f" == "$nf" ]] || safe_mv "$f" "$nf"'

  # B) any *V3* → *LPP*
  find "$ROOT" -depth -name '*V3*' -print0 | \
  xargs -0 -I{} bash -c 'f="{}"; nf="$(echo "$f" | sed -E s/V3/LPP/g)"; [[ "$f" == "$nf" ]] || safe_mv "$f" "$nf"'
done

# ---------- IN-FILE REWRITES ----------
# Build file list (skip build/artifacts)
file_list () {
  local ROOT="$1"
  find "$ROOT" \
    \( -name .git -o -name node_modules -o -name artifacts -o -name cache -o -name typechain -o -name dist -o -name build \) -prune -o \
    -type f \( -name '*.sol' -o -name '*.ts' -o -name '*.js' -o -name '*.md' -o -name '*.json' -o -name '*.yml' -o -name '*.yaml' \) -print0
}

# Apply perl in one pass per file
apply_perl () {
  perl -0777 -i -pe '
    # 1) Exact brand first
    s/UniswapV3/LPP/g;

    # 2) Any remaining V3 tokens → LPP (standalone or suffix)
    s/\bV3\b/LPP/g;              # "... V3" -> "... LPP"
    s/([A-Za-z])V3\b/\1LPP/g;    # FooV3 -> FooLPP
    s/\bv3\b/lpp/g;              # lowercase tokens like uniswapv3 (rare)

    # 3) Contracts & interfaces with UniswapV3 in the name
    s/\bIUniswapV3([A-Za-z]+)\b/ILPP\1/g;   # IUniswapV3Pool -> ILPPPool
    s/\bUniswapV3([A-Za-z]+)\b/LPP\1/g;     # UniswapV3Pool   -> LPPPool

    # 4) Lowercase function identifiers that start with "uniswapV3"
    s/uniswapV3([A-Za-z0-9_]+)/lpp\1/g;     # uniswapV3MintCallback -> lppMintCallback, etc.
  ' "$1"
}

echo "▶️  Rewriting file contents…"
while IFS= read -r -d '' f; do apply_perl "$f"; done < <(file_list "$PROT")
while IFS= read -r -d '' f; do apply_perl "$f"; done < <(file_list "$PERF")

# ---------- REPORT ----------
echo "— Counts AFTER —"
grep -RInE "UniswapV3|(^|[^A-Za-z])V3([^A-Za-z]|$)|uniswapV3" "$PROT" "$PERF" --include='*.sol' --include='*.ts' --include='*.js' --include='*.md' --include='*.json' --include='*.yml' --include='*.yaml' | wc -l | xargs echo "Matches:"

echo "✅ Done."
