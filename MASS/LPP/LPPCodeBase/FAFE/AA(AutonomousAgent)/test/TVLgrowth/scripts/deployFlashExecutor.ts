import hardhat from "hardhat";

const { ethers } = hardhat;

const DEFAULT_PROVIDER = (process.env.AAVE_ADDRESSES_PROVIDER_BASE ??
  "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb").trim();
const DEFAULT_POOL_RAW = (process.env.AAVE_POOL_BASE ??
  process.env.AAVE_POOL ??
  "").trim();
async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No signer available. Set PRIVATE_KEY to deploy on Base.");
  }

  console.log(`Deploying with ${deployer.address}`);
  const factory = await ethers.getContractFactory("FlashArbExecutor");
  const providerAddr = ethers.getAddress(DEFAULT_PROVIDER.toLowerCase());
  const poolOverride =
    DEFAULT_POOL_RAW.length === 0
      ? ethers.ZeroAddress
      : ethers.getAddress(DEFAULT_POOL_RAW.toLowerCase());
  const contract = await factory.deploy(providerAddr, poolOverride);
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  console.log(`FlashArbExecutor deployed at ${addr}`);
  console.log("Remember to set profitRecipient if needed (default = deployer).");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

