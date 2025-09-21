#!/usr/bin/env bash
set -eo pipefail

echo "▶️  LPP mass-rename starting..."

# --- Detect layout ---
if [[ -d "protocol" && -d "periphery" ]]; then
  PROT="protocol"
  PERF="periphery"
elif [[ -d "Infrastructure/protocol" && -d "Infrastructure/periphery" ]]; then
  PROT="Infrastructure/protocol"
  PERF="Infrastructure/periphery"
elif [[ -d "infrastructure/protocol" && -d "infrastructure/periphery" ]]; then
  PROT="infrastructure/protocol"
  PERF="infrastructure/periphery"
else
  echo "❌ Could not find {protocol,periphery} here. pwd=$(pwd)"; ls -la
  exit 1
fi

# --- Tooling checks ---
PERL_BIN="${PERL_BIN:-perl}"
command -v "$PERL_BIN" >/dev/null 2>&1 || { echo "❌ perl is required (install via brew/apt)"; exit 1; }
HAS_RG=1; command -v rg >/dev/null 2>&1 || HAS_RG=0

# --- Helper: safe move (uses git mv if repo) ---
safe_mv () {
  local src="$1" dst="$2"
  [[ "$src" == "$dst" ]] && return 0
  mkdir -p "$(dirname "$dst")"
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git mv -f "$src" "$dst" 2>/dev/null || mv -f "$src" "$dst"
  else
    mv -f "$src" "$dst"
  fi
  echo "  mv: $src -> $dst"
}

# --- 1) PATH RENAMES: UniswapV3* → LPP* (depth-first) ---
for ROOT in "$PROT" "$PERF"; do
  while IFS= read -r -d '' P; do
    NEW="${P/UniswapV3/LPP}"
    safe_mv "$P" "$NEW"
  done < <(find "$ROOT" -depth -name '*UniswapV3*' -print0)
done

# --- 2) PATH RENAMES: *Swap* → *Supplicate* ---
for ROOT in "$PROT" "$PERF"; do
  while IFS= read -r -d '' P; do
    NEW="$(echo "$P" | sed -E 's/Swap/Supplicate/g')"
    safe_mv "$P" "$NEW"
  done < <(find "$ROOT" -depth -name '*Swap*' -print0)
done

# --- 3) Build list of source files (skip build dirs) ---
file_list () {
  local ROOT="$1"
  find "$ROOT" \
    \( -name .git -o -name node_modules -o -name artifacts -o -name cache -o -name typechain -o -name dist -o -name build \) -prune -o \
    \( -type f -a \( -name '*.sol' -o -name '*.ts' -o -name '*.js' -o -name '*.md' -o -name '*.json' -o -name '*.yml' -o -name '*.yaml' \) \) -print0
}

# --- 4) In-file replacements (case-aware, word-safe) ---
replace_in_file () {
  local F="$1"
  "$PERL_BIN" -0777 -i -pe '
    s/UniswapV3/LPP/g;
    s/\bI(?:LPP)?SwapCallback\b/ILPPSupplicateCallback/g;
    s/uniswapV3SwapCallback/lppSupplicateCallback/g;
    s/\bSwapMath\b/SupplicateMath/g;
    s/\bswap\b/supplicate/g;
    s/\bSwap\b/Supplicate/g;
    s/\bSWAP\b/SUPPLICATE/g;
  ' "$F"
}

echo "▶️  Rewriting identifiers in files..."
while IFS= read -r -d '' F; do replace_in_file "$F"; done < <(file_list "$PROT")
while IFS= read -r -d '' F; do replace_in_file "$F"; done < <(file_list "$PERF")

# --- 5) Quick scan for leftovers ---
echo "🔎 Scan for leftovers (ok if empty):"
if [[ $HAS_RG -eq 1 ]]; then
  rg --no-heading -n "UniswapV3|SwapRouter|ISwapRouter|\bswap\s*\(" "$PROT" "$PERF" || true
else
  grep -RIn "UniswapV3\|SwapRouter\|ISwapRouter\|\bswap\s*(" "$PROT" "$PERF" || true
fi

echo "✅ Done. Now recompile: (cd $PROT && yarn hardhat compile) and (cd $PERF && yarn hardhat compile) or your Foundry equivalents."
