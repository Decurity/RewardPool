const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");

const {
  tokens,
  getBlockTime,
  timeShiftBy,
  deployRewardPool,
  makeStakeFor,
  makeUnstake,
  makeRequestUnstake,
  makeDistributeReward,
  makeWithdrawReward,
  makeChangeUnstakePeriod,
} = require("../utils/utils");
const { Log } = require("ethers");

const INIT_MINT = tokens("100000");
const BASE_STAKE = tokens("100");
const BASE_REWARD = tokens("100");
const BASE_DEPO = BASE_STAKE * 10n;
const ONE_SECOND = 1;
const ONE_DAY = 60 * 60 * 24;
const ONE_WEEK = ONE_DAY * 7;
const UNSTAKEPERIOD = ONE_WEEK;

describe("RewardPool", function () {
  async function deployDistributorFixture() {
    const [owner, user1, user2, user3] = await ethers.getSigners();
    const users = [user1, user2, user3];

    const AZUR = await ethers.getContractFactory("TestERC20", { signer: owner });
    const azur = await AZUR.deploy("AZUR", "AZUR", INIT_MINT);
    await azur.waitForDeployment();

    const rewardPool = await deployRewardPool(azur, owner, UNSTAKEPERIOD);
    const rewardPoolAddress = await rewardPool.getAddress();

    await azur.connect(owner).approve(rewardPoolAddress, INIT_MINT);
    for (const i of users) {
      await azur.connect(owner).transfer(i.address, BASE_DEPO);
      await azur.connect(i).approve(rewardPoolAddress, BASE_DEPO);
    }

    return { rewardPool, azur, owner, users };
  }

  describe("Deployment", function () {
    it("Try reinitialize", async function () {
      const { rewardPool, azur } = await loadFixture(deployDistributorFixture);
      await expect(rewardPool.initialize(azur, 0)).to.be.revertedWithCustomError(rewardPool, "InvalidInitialization()");
    });
    it("Should set the right owner", async function () {
      const { rewardPool, owner } = await loadFixture(deployDistributorFixture);
      expect(await rewardPool.owner()).to.equal(owner.address);
    });
    it("Try reward no stakes pool ", async function () {
      const { rewardPool, owner } = await loadFixture(deployDistributorFixture);
      await expect(makeDistributeReward(rewardPool, owner, BASE_REWARD)).to.revertedWithCustomError(
        rewardPool,
        "NoStakes()"
      );
    });
    it("Get equal stakes from 3 stakers, withdraw stakes", async function () {
      const { rewardPool, users } = await loadFixture(deployDistributorFixture);
      let resStakes = [];
      let resUnstake;

      for (const i of users) {
        resStakes.push({ stake: await makeStakeFor(rewardPool, i, BASE_STAKE), staker: i });
        await timeShiftBy(ethers, ONE_DAY);
      }
      // last staker add second stake
      resStakes.push({ stake: await makeStakeFor(rewardPool, users[2], BASE_STAKE), staker: users[2] });

      for (const i of resStakes) await makeRequestUnstake(rewardPool, i.staker, i.stake.stakeId);

      for (const i of resStakes)
        await expect(makeUnstake(rewardPool, i.staker, i.stake.stakeId)).to.be.revertedWithCustomError(
          rewardPool,
          "IncorrectUnstakeTime()"
        );

      await timeShiftBy(ethers, UNSTAKEPERIOD);

      for (const i of resStakes) {
        resUnstake = await makeUnstake(rewardPool, i.staker, i.stake.stakeId);
        await timeShiftBy(ethers, ONE_DAY);
        expect(resUnstake.amount).to.be.eq(BASE_STAKE);
      }
    });
    it("Get equal stakes from 3 stakers, add reward, withdraw stakes", async function () {
      const { rewardPool, azur, owner, users } = await loadFixture(deployDistributorFixture);
      let resStakes = [];
      let balancesGains = [];
      let totalRewards = 0n,
        gain;

      for (const i of users) {
        resStakes.push({ stake: await makeStakeFor(rewardPool, i, BASE_STAKE), staker: i });
        await timeShiftBy(ethers, ONE_WEEK);
      }

      await timeShiftBy(ethers, ONE_DAY);

      // try distribute from not owner
      await expect(makeDistributeReward(rewardPool, users[0], BASE_REWARD))
        .to.be.revertedWithCustomError(rewardPool, "OwnableUnauthorizedAccount")
        .withArgs(users[0].address);

      await makeDistributeReward(rewardPool, owner, BASE_REWARD);

      for (const i of resStakes) await makeRequestUnstake(rewardPool, i.staker, i.stake.stakeId);
      await timeShiftBy(ethers, UNSTAKEPERIOD);

      for (const i of resStakes) {
        expect((await makeUnstake(rewardPool, i.staker, i.stake.stakeId)).amount).to.be.eq(BASE_STAKE);
        gain = (await azur.balanceOf(i.staker.address)) - BASE_DEPO;
        balancesGains.push(gain);
        totalRewards += gain;
      }
      expect(totalRewards).to.be.closeTo(BASE_REWARD, 1);

      for (let i = 0; i < balancesGains.length - 1; i++) expect(balancesGains[i]).gt(balancesGains[i + 1]);
    });
    it("Get equal stakes from 3 stakers, add reward, withdraw rewards, second reward, check equality rewards", async function () {
      const { rewardPool, owner, users } = await loadFixture(deployDistributorFixture);
      let resStakes = [];
      let resUnstakes = [];
      let withdrawals = [];
      let withdrawn,
        totalRewards = 0n;

      for (const i of users) {
        resStakes.push({ stake: await makeStakeFor(rewardPool, i, BASE_STAKE), staker: i });
        await timeShiftBy(ethers, ONE_DAY);
      }

      await makeDistributeReward(rewardPool, owner, BASE_REWARD);

      // try wintdraw revard from not owned stake
      await expect(
        makeWithdrawReward(rewardPool, resStakes[0].staker, resStakes[2].stake.stakeId)
      ).to.be.revertedWithCustomError(rewardPool, "NotStakeOwner()");

      for (const i of resStakes) {
        withdrawn = await makeWithdrawReward(rewardPool, i.staker, i.stake.stakeId);
        withdrawals.push(withdrawn);
        await timeShiftBy(ethers, ONE_SECOND);

        totalRewards += withdrawn.reward;
      }
      expect(totalRewards).to.be.closeTo(BASE_REWARD, 1);
      for (let i = 0; i < resUnstakes.length - 1; i++) expect(resUnstakes[i].reward).gt(resUnstakes[i + 1].reward);

      // second reward
      await timeShiftBy(ethers, ONE_DAY);
      await makeDistributeReward(rewardPool, owner, BASE_REWARD);

      totalRewards = 0n;
      withdrawals = [];
      for (const i of resStakes) {
        withdrawn = await makeWithdrawReward(rewardPool, i.staker, i.stake.stakeId);
        withdrawals.push(withdrawn);
        totalRewards += withdrawn.reward;
        await timeShiftBy(ethers, ONE_SECOND);
      }

      expect(totalRewards).to.be.closeTo(BASE_REWARD, 1);
      for (let i = 0; i < withdrawals.length - 1; i++) expect(withdrawals[i].reward).eq(withdrawals[i + 1].reward);
    });
    it("Get 3 equal stakes from one staker, add reward, withdraw rewards depends of time", async function () {
      const { rewardPool, owner, users } = await loadFixture(deployDistributorFixture);
      let resStakes = [];
      let resUnstakes = [];
      let unstaked,
        totalRewards = 0n,
        user = users[0];

      await expect(makeChangeUnstakePeriod(rewardPool, users[0], UNSTAKEPERIOD * 2))
        .to.be.revertedWithCustomError(rewardPool, "OwnableUnauthorizedAccount")
        .withArgs(users[0].address);
      let resChange = await makeChangeUnstakePeriod(rewardPool, owner, UNSTAKEPERIOD * 2);
      expect(resChange.newUnstakePeriod).to.be.eq(UNSTAKEPERIOD * 2);
      expect(await rewardPool.unstakePeriod()).to.be.eq(UNSTAKEPERIOD * 2);

      for (const i of Array(3).keys()) {
        resStakes.push(await makeStakeFor(rewardPool, user, BASE_STAKE));
        await timeShiftBy(ethers, ONE_DAY);
      }

      await makeDistributeReward(rewardPool, owner, BASE_REWARD);

      for (const i of resStakes) {
        unstaked = await makeRequestUnstake(rewardPool, user, i.stakeId);
        await timeShiftBy(ethers, ONE_SECOND);

        resUnstakes.push(unstaked);
        totalRewards += unstaked.reward;
        expect(unstaked.amount).to.be.eq(BASE_STAKE);
      }

      expect(totalRewards).to.be.closeTo(BASE_REWARD, 1);
      for (let i = 0; i < resUnstakes.length - 1; i++) expect(resUnstakes[i].reward).gt(resUnstakes[i + 1].reward);
    });
    it("Get 3 equal stakes from one staker, add reward, batch withdraw rewards, batch unstake", async function () {
      const { rewardPool, azur, owner, users } = await loadFixture(deployDistributorFixture);
      let resStakes = [];
      let stakeList = [];
      let user = users[0];

      for (const i of Array(3).keys()) {
        resStakes.push(await makeStakeFor(rewardPool, user, BASE_STAKE));
        await timeShiftBy(ethers, ONE_DAY);
      }

      for (const i of resStakes) stakeList.push(i.stakeId);

      await makeDistributeReward(rewardPool, owner, BASE_REWARD);

      let balanceBefore = await azur.balanceOf(user.address);
      await rewardPool.connect(user).batchWithdrawReward(stakeList);
      expect((await azur.balanceOf(user.address)) - balanceBefore).to.be.closeTo(BASE_REWARD, 1);

      await rewardPool.connect(user).batchRequestUnstake(stakeList);
      await timeShiftBy(ethers, ONE_WEEK);
      await rewardPool.connect(user).batchUnstake(stakeList);
    });
    it("Get equal stakes from 3 stakers, second staker withdrawn, add reward, withdraw stakes with rewards", async function () {
      const { rewardPool, azur, owner, users } = await loadFixture(deployDistributorFixture);
      let resStakes = [];
      let balancesGains = [];
      let totalRewards = 0n,
        gain;

      for (const i of users) {
        resStakes.push({ stake: await makeStakeFor(rewardPool, i, BASE_STAKE), staker: i });
        await timeShiftBy(ethers, ONE_WEEK);
      }
      await timeShiftBy(ethers, ONE_DAY);

      // second staker withdraw
      await makeRequestUnstake(rewardPool, resStakes[1].staker, resStakes[1].stake.stakeId);
      await timeShiftBy(ethers, UNSTAKEPERIOD);

      expect((await makeUnstake(rewardPool, resStakes[1].staker, resStakes[1].stake.stakeId)).amount).to.be.eq(
        BASE_STAKE
      );

      // try unstake already unstaked
      await expect(
        makeUnstake(rewardPool, resStakes[1].staker, resStakes[1].stake.stakeId)
      ).to.be.revertedWithCustomError(rewardPool, "IncorrectUnstake()");

      await makeDistributeReward(rewardPool, owner, BASE_REWARD);

      for (const i of resStakes) {
        // exclude second staker
        if (i.staker == resStakes[1].staker) continue;
        await makeRequestUnstake(rewardPool, i.staker, i.stake.stakeId);
      }
      await timeShiftBy(ethers, UNSTAKEPERIOD);

      for (const i of resStakes) {
        // exclude second staker
        if (i.staker == resStakes[1].staker) continue;
        expect((await makeUnstake(rewardPool, i.staker, i.stake.stakeId)).amount).to.be.eq(BASE_STAKE);

        gain = (await azur.balanceOf(i.staker.address)) - BASE_DEPO;
        balancesGains.push(gain);
        totalRewards += gain;
      }
      expect(await azur.balanceOf(resStakes[1].staker)).to.be.eq(BASE_DEPO);
      expect(totalRewards).to.be.closeTo(BASE_REWARD, 1);
      expect(balancesGains[0]).gt(balancesGains[1]);
    });
  });
});
