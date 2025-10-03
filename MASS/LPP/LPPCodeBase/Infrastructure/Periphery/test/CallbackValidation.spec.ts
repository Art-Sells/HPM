// test/CallbackValidation.spec.ts
import hre from 'hardhat';
const { ethers } = hre;

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { Contract, MaxUint256 } from 'ethers';

import completeFixture from './shared/completeFixture.ts';
import { expect } from './shared/expect.ts';
import { FeeAmount } from './shared/constants.ts';

import type { TestERC20, TestCallbackValidation } from '../typechain-types';


describe('CallbackValidation', () => {
  let nonpairAddr: SignerWithAddress;
  let wallets: SignerWithAddress[];

  async function callbackValidationFixture() {
    // signers
    const all = await ethers.getSigners();
    const [nonpair, ...rest] = all;

    // whatever your completeFixture returns; keeping your original call shape
    const { factory } = await completeFixture(all, ethers.provider);

    // deploy test tokens with half MaxUint256 (use bigint arithmetic in v6)
    const half = MaxUint256 / 2n;
    const tokenFactory = await ethers.getContractFactory('TestERC20');
    const token0 = (await tokenFactory.deploy(half)) as unknown as TestERC20;
    const token1 = (await tokenFactory.deploy(half)) as unknown as TestERC20;

    // deploy callback validation helper
    const cvFactory = await ethers.getContractFactory('TestCallbackValidation');
    const callbackValidation = (await cvFactory.deploy()) as unknown as TestCallbackValidation;

    return {
      nonpair,
      wallets: rest,
      callbackValidation,
      tokens: [token0, token1] as [TestERC20, TestERC20],
      factory,
    };
  }

  before(async () => {
    const signers = await ethers.getSigners();
    [nonpairAddr, ...wallets] = signers as SignerWithAddress[];
  });

  it('reverts when called from an address other than the associated LPPPool', async () => {
    const { callbackValidation, tokens, factory } = await loadFixture(callbackValidationFixture);

    await expect(
      callbackValidation
        .connect(nonpairAddr)
        .verifyCallback(factory.address, tokens[0].address, tokens[1].address, FeeAmount.MEDIUM)
    ).to.be.reverted;
  });
});