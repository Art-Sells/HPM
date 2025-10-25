// test/shared/fixtures.ts
import hre from 'hardhat'
const { ethers } = hre

// Type-only imports from the v6 typechain output
import type {
  MockTimeLPPPool,
  TestERC20,
  LPPFactory,
  TestLPPCallee,
  TestLPPRouter,
  MockTimeLPPPoolDeployer,
} from '../../typechain-types/protocol'

// Minimal Fixture type (replaces ethereum-waffle's Fixture)
export type Fixture<T> = (...args: any[]) => Promise<T>

interface FactoryFixture {
  factory: LPPFactory
}

async function factoryFixture(): Promise<FactoryFixture> {
  const Factory = await ethers.getContractFactory('LPPFactory')
  const factory = (await Factory.deploy()) as unknown as LPPFactory
  await factory.waitForDeployment()
  return { factory }
}

interface TokensFixture {
  token0: TestERC20
  token1: TestERC20
  token2: TestERC20
}

async function tokensFixture(): Promise<TokensFixture> {
  const ERC20 = await ethers.getContractFactory('TestERC20')

  // initial supply = 2^255
  const init = (1n << 255n)

  const tokenA = (await ERC20.deploy(init)) as unknown as TestERC20
  const tokenB = (await ERC20.deploy(init)) as unknown as TestERC20
  const tokenC = (await ERC20.deploy(init)) as unknown as TestERC20

  await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment(), tokenC.waitForDeployment()])

  const addrA = (await tokenA.getAddress()).toLowerCase()
  const addrB = (await tokenB.getAddress()).toLowerCase()
  const addrC = (await tokenC.getAddress()).toLowerCase()

  const sorted = [
    { token: tokenA, addr: addrA },
    { token: tokenB, addr: addrB },
    { token: tokenC, addr: addrC },
  ].sort((x, y) => (x.addr < y.addr ? -1 : 1))

  const [token0, token1, token2] = sorted.map((t) => t.token)
  return { token0, token1, token2 }
}

type TokensAndFactoryFixture = FactoryFixture & TokensFixture

interface PoolFixture extends TokensAndFactoryFixture {
  supplicateTargetCallee: TestLPPCallee
  supplicateTargetRouter: TestLPPRouter
  createPool(
    fee: number,
    tickSpacing: number,
    firstToken?: TestERC20,
    secondToken?: TestERC20
  ): Promise<MockTimeLPPPool>
}

// Monday, October 5, 2020 9:00:00 AM GMT-05:00
export const TEST_POOL_START_TIME = 1601906400

export const poolFixture: Fixture<PoolFixture> = async function (): Promise<PoolFixture> {
  const { factory } = await factoryFixture()
  const { token0, token1, token2 } = await tokensFixture()

  const DeployerFactory = await ethers.getContractFactory('MockTimeLPPPoolDeployer')
  const PoolFactory = await ethers.getContractFactory('MockTimeLPPPool')

  const CalleeFactory = await ethers.getContractFactory('TestLPPCallee')
  const RouterFactory = await ethers.getContractFactory('TestLPPRouter')

  const supplicateTargetCallee = (await CalleeFactory.deploy()) as unknown as TestLPPCallee
  const supplicateTargetRouter = (await RouterFactory.deploy()) as unknown as TestLPPRouter

  await Promise.all([supplicateTargetCallee.waitForDeployment(), supplicateTargetRouter.waitForDeployment()])

  return {
    token0,
    token1,
    token2,
    factory,
    supplicateTargetCallee,
    supplicateTargetRouter,
    createPool: async (fee, tickSpacing, firstToken = token0, secondToken = token1) => {
      const deployer = (await DeployerFactory.deploy()) as unknown as MockTimeLPPPoolDeployer
      await deployer.waitForDeployment()

      const factoryAddr = await factory.getAddress()
      const t0 = await firstToken.getAddress()
      const t1 = await secondToken.getAddress()

      const tx = await (deployer as any).deploy(factoryAddr, t0, t1, fee, tickSpacing)
      const receipt = await tx.wait()

      // Parse the pool address from the deployer event
      let poolAddress: string | undefined
      for (const log of receipt!.logs) {
        try {
          const parsed = (deployer as any).interface.parseLog(log)
          const args: any = parsed.args
          if (args && typeof args.pool === 'string') {
            poolAddress = args.pool
            break
          } else if (Array.isArray(args) && typeof args[0] === 'string') {
            poolAddress = args[0]
            break
          }
        } catch {
          // not an event from this contract; ignore
        }
      }

      if (!poolAddress) {
        throw new Error('MockTimeLPPPoolDeployer: pool address not found in logs')
      }

      // Attach to the deployed mock-time pool
      return PoolFactory.attach(poolAddress) as unknown as MockTimeLPPPool
    },
  }
}