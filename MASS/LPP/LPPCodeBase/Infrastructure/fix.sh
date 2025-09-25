#!/bin/bash
set -e

echo "🔧 Pin Node 22 + Yarn"
volta pin node@22 yarn@1.22.22 2>/dev/null || true

echo "🔧 Protocol: SwapMath -> SupplicateMath"
grep -RIl "libraries/SwapMath\.sol" Protocol/contracts | xargs -I{} \
  sed -i '' -e 's#\./libraries/SwapMath\.sol#./libraries/SupplicateMath.sol#g' \
            -e 's#\.\./libraries/SwapMath\.sol#../libraries/SupplicateMath.sol#g' {}

grep -RIl "\bSwapMath\b" Protocol/contracts | xargs -I{} \
  sed -i '' 's/\bSwapMath\b/SupplicateMath/g' {}

echo "📂 Protocol libraries:"
ls -1 Protocol/contracts/libraries/*Math*.sol

echo "🔧 Periphery: QuoterV2 import/name"
grep -RIl "\bISupplicateQuoterV2\b" Periphery/contracts | xargs -I{} \
  sed -i '' 's/\bISupplicateQuoterV2\b/IQuoterV2/g' {}

grep -RIl "interfaces/ISupplicateQuoterV2\.sol" Periphery/contracts | xargs -I{} \
  sed -i '' 's#interfaces/ISupplicateQuoterV2\.sol#interfaces/IQuoterV2.sol#g' {}

ls -1 Periphery/contracts/interfaces/*QuoterV2*.sol

echo "🔧 Periphery: callback rename"
grep -RIl "@lpp/lpp-protocol/contracts/interfaces/callback/ILPPSwapCallback\.sol" Periphery/contracts | xargs -I{} \
  sed -i '' 's#ILPPSwapCallback\.sol#ILPPSupplicateCallback.sol#g' {}

grep -RIl "\bILPPSwapCallback\b" Periphery/contracts | xargs -I{} \
  sed -i '' 's/\bILPPSwapCallback\b/ILPPSupplicateCallback/g' {}

grep -RIl "\blppSwapCallback\b" Periphery/contracts | xargs -I{} \
  sed -i '' 's/\blppSwapCallback\b/lppSupplicateCallback/g' {}

echo "✅ Done. Now clean & compile:"
echo "cd Protocol  && yarn hardhat clean && yarn hardhat compile --show-stack-traces"
echo "cd Periphery && yarn hardhat clean && yarn hardhat compile --show-stack-traces"


