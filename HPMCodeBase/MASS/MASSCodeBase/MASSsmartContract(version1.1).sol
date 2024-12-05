
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MASSsmartContract {
    address public owner;
    ERC20 public wbtc;
    ERC20 public usdc;

    constructor(address _wbtc, address _usdc) {
        owner = msg.sender;
        wbtc = ERC20(_wbtc);
        usdc = ERC20(_usdc);
    }

    event Supplicate(address indexed from, uint256 amount, string supplicateType);

    function supplicateWBTCtoUSDC(uint256 amount, uint256 bitcoinPrice) external {
        require(wbtc.transferFrom(msg.sender, address(this), amount), "WBTC transfer failed");
        uint256 usdcAmount = getUSDCEquivalent(amount, bitcoinPrice);
        usdc.transfer(msg.sender, usdcAmount);
        emit Supplicate(msg.sender, amount, "WBTC to USDC");
    }

    function supplicateUSDCtoWBTC(uint256 amount, uint256 bitcoinPrice) external {
        require(usdc.transferFrom(msg.sender, address(this), amount), "USDC transfer failed");
        uint256 wbtcAmount = getWBTCEquivalent(amount, bitcoinPrice);
        wbtc.transfer(msg.sender, wbtcAmount);
        emit Supplicate(msg.sender, amount, "USDC to WBTC");
    }

    function getUSDCEquivalent(uint256 wbtcAmount, uint256 bitcoinPrice) public pure returns (uint256) {
        return wbtcAmount * bitcoinPrice; // Example: 1 WBTC * bitcoinPrice = USDC amount
    }

    function getWBTCEquivalent(uint256 usdcAmount, uint256 bitcoinPrice) public pure returns (uint256) {
        return usdcAmount / bitcoinPrice; // Example: USDC amount / bitcoinPrice = 1 WBTC
    }
}
