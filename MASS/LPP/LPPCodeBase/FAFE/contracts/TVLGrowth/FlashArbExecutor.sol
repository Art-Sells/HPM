// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../external/IERC20.sol";
import "../external/SafeERC20.sol";
import "../external/Ownable.sol";

interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IFlashLoanSimpleReceiver {
    function ADDRESSES_PROVIDER() external view returns (IPoolAddressesProvider);

    function POOL() external view returns (IPool);

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/// @notice Flash-loan executor that routes arbitrary swap calls (e.g., Uniswap v3, Aerodrome, 0x)
/// Profits (borrowed asset) are forwarded to the configured recipient after repaying the loan.
contract FlashArbExecutor is IFlashLoanSimpleReceiver, Ownable {
    using SafeERC20 for IERC20;

    struct SwapCall {
        address target;
        address spender;
        bytes data;
        uint256 value;
        address token;
    }

    struct FlashParams {
        address recipient;
        uint256 minProfit;
        SwapCall[] calls;
    }

    IPoolAddressesProvider public immutable override ADDRESSES_PROVIDER;
    IPool public immutable override POOL;
    address public profitRecipient;

    event FlashArbExecuted(address indexed asset, uint256 amount, uint256 premium, uint256 profit);
    event ProfitRecipientUpdated(address indexed newRecipient);

    constructor(IPoolAddressesProvider provider, address poolAddress) {
        require(address(provider) != address(0), "invalid provider");
        address resolvedPool = poolAddress;
        if (resolvedPool == address(0)) {
            resolvedPool = provider.getPool();
        }
        require(resolvedPool != address(0), "invalid pool");
        ADDRESSES_PROVIDER = provider;
        POOL = IPool(resolvedPool);
        profitRecipient = msg.sender;
    }

    receive() external payable {}

    function setProfitRecipient(address newRecipient) external onlyOwner {
        profitRecipient = newRecipient;
        emit ProfitRecipientUpdated(newRecipient);
    }

    function executeFlashArb(
        address asset,
        uint256 amount,
        FlashParams calldata params
    ) external onlyOwner {
        require(params.calls.length > 0, "no calls");
        require(asset != address(0) && amount > 0, "invalid asset");
        POOL.flashLoanSimple(address(this), asset, amount, abi.encode(params), 0);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata paramsData
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "not pool");
        require(initiator == address(this), "invalid initiator");

        FlashParams memory params = abi.decode(paramsData, (FlashParams));
        uint256 callCount = params.calls.length;
        for (uint256 i = 0; i < callCount; i++) {
            _executeSwapCall(params.calls[i]);
        }

        uint256 totalOwed = amount + premium;
        uint256 balance = IERC20(asset).balanceOf(address(this));
        require(balance >= totalOwed + params.minProfit, "min profit not met");

        uint256 profit = balance - totalOwed;
        if (profit > 0) {
            IERC20(asset).safeTransfer(
                params.recipient == address(0) ? (profitRecipient == address(0) ? owner : profitRecipient) : params.recipient,
                profit
            );
        }

        IERC20(asset).safeApprove(address(POOL), 0);
        IERC20(asset).safeApprove(address(POOL), totalOwed);

        emit FlashArbExecuted(asset, amount, premium, profit);
        return true;
    }

    function rescueToken(address token, address to) external onlyOwner {
        IERC20(token).safeTransfer(to == address(0) ? owner : to, IERC20(token).balanceOf(address(this)));
    }

    function rescueEth(address to) external onlyOwner {
        address payable recipient = payable(to == address(0) ? owner : to);
        recipient.transfer(address(this).balance);
    }

    function _executeSwapCall(SwapCall memory call) internal {
        if (call.token != address(0) && call.spender != address(0)) {
            IERC20(call.token).safeApprove(call.spender, 0);
            IERC20(call.token).safeApprove(call.spender, type(uint256).max);
        }

        (bool success, bytes memory returndata) = call.target.call{value: call.value}(call.data);
        require(success, _getRevertMsg(returndata));

        if (call.token != address(0) && call.spender != address(0)) {
            IERC20(call.token).safeApprove(call.spender, 0);
        }
    }

    function _getRevertMsg(bytes memory returndata) internal pure returns (string memory) {
        if (returndata.length < 68) return "swap call failed";
        assembly {
            returndata := add(returndata, 0x04)
        }
        return abi.decode(returndata, (string));
    }
}

