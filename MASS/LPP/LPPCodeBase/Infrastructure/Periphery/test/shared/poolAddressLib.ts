import hre from 'hardhat'
const { ethers } = hre

let _exposer: any

async function exposer() {
  if (!_exposer) {
    const Fac = await ethers.getContractFactory('PoolAddressTest')
    _exposer = await Fac.deploy()
    await _exposer.waitForDeployment()
  }
  return _exposer
}

export async function getInitHash(): Promise<string> {
  const lib = await exposer()
  return lib.POOL_INIT_CODE_HASH()
}

export async function computeExpectedPool(factory: string, tokenA: string, tokenB: string, fee: number) {
  // PoolAddress.computeAddress requires token0 < token1
  let [token0, token1] = [tokenA, tokenB]
  if (token0.toLowerCase() > token1.toLowerCase()) [token0, token1] = [token1, token0]
  const lib = await exposer()
  return lib.computeAddress(factory, token0, token1, fee)
}