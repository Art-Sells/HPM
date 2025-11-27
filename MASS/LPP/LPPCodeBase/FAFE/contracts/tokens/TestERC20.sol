// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC20 strictly for local/testnet usage.
/// - Minting is restricted to a designated minter (test harness)
/// - Minting is HARD-DISABLED on production chain IDs (e.g., 8453 Base mainnet)
/// - Optional kill-switch lets the minter permanently disable minting even on testnets
contract TestERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public minter;
    bool    public mintingDisabled; // kill-switch

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterUpdated(address indexed previous, address indexed next);
    event MintingDisabled();

    modifier onlyMinter() {
        require(msg.sender == minter, "not minter");
        _;
    }

    constructor(string memory _name, string memory _symbol, address _minter) {
        name = _name;
        symbol = _symbol;
        require(_minter != address(0), "zero minter");
        minter = _minter;
        emit MinterUpdated(address(0), _minter);
    }

    /// @dev chain gate: revert on production L1/L2s.
    function _enforceTestnet() internal view {
        // allow: Hardhat/Anvil 31337, Local 1337, Base Sepolia 84532, Sepolia 11155111
        uint256 id = block.chainid;
        bool ok = (
            id == 31337 ||  // Hardhat/Anvil
            id == 1337  ||  // Local
            id == 84532 ||  // Base Sepolia
            id == 11155111   // Sepolia
        );
        require(ok, "TestERC20: not allowed on this chain");
    }

    function setMinter(address _minter) external onlyMinter {
        require(_minter != address(0), "zero minter");
        emit MinterUpdated(minter, _minter);
        minter = _minter;
    }

    /// @notice Irreversibly disable minting (even on testnets).
    function disableMinting() external onlyMinter {
        mintingDisabled = true;
        emit MintingDisabled();
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "insufficient allowance");
            unchecked { allowance[from][msg.sender] = allowed - value; }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "to zero");
        uint256 bal = balanceOf[from];
        require(bal >= value, "insufficient balance");
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to]   += value;
        }
        emit Transfer(from, to, value);
    }

    /// @notice Faucet mint — only for tests. Chain-gated + kill-switch enforced.
    function mint(address to, uint256 value) external onlyMinter {
        _enforceTestnet();
        require(!mintingDisabled, "minting disabled");
        require(to != address(0), "to zero");
        totalSupply += value;
        unchecked { balanceOf[to] += value; }
        emit Transfer(address(0), to, value);
    }
}