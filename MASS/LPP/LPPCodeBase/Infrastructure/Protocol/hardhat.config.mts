import { HardhatUserConfig } from "hardhat/config";


import "@nomicfoundation/hardhat-toolbox";


import "@nomicfoundation/hardhat-ethers";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 800 } } },
      { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 } } },
    ],
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: false,
    },
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};

export default config;