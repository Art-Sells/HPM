// hardhat.config.cjs
require("@nomicfoundation/hardhat-toolbox"); // includes ethers, waffle, etc.
require("@typechain/hardhat");

/** @type import("hardhat/config").HardhatUserConfig */
const config = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true, 
        },
      },
    ],
  },
  networks: {
    hardhat: { allowUnlimitedContractSize: true },
    base: {
      url: process.env.BASE_RPC_URL || "https://base-mainnet.infura.io/v3/4885ed01637e4a6f91c2c7fcd1714f68",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "base-sepolia": {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://base-sepolia.infura.io/v3/4885ed01637e4a6f91c2c7fcd1714f68",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

module.exports = config;