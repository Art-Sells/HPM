import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{ 
      version: "0.8.24", 
      settings: { 
        optimizer: { enabled: true, runs: 200 },
        viaIR: true, 
      } 
    }],
  },
  networks: {
    hardhat: { allowUnlimitedContractSize: false },
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};

export default config;