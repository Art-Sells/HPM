// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

/// @title SafeTokenNamer (LPP)
/// @notice Safely retrieves ERC20 name/symbol (string or bytes32) with address fallback.
library SafeTokenNamer {
    function _toHexDigit(uint8 d) private pure returns (bytes1) {
        return bytes1(uint8(d) + (d < 10 ? 48 : 87)); // 0-9->'0'-'9', 10-15->'a'-'f'
    }

    function _toAsciiString(address account) internal pure returns (string memory) {
        bytes20 data = bytes20(account);
        bytes memory str = new bytes(2 + 40);
        str[0] = '0';
        str[1] = 'x';
        for (uint256 i = 0; i < 20; i++) {
            uint8 b = uint8(data[i]);
            str[2 + (i * 2)]     = _toHexDigit(b >> 4);
            str[2 + (i * 2) + 1] = _toHexDigit(b & 0x0f);
        }
        return string(str);
    }

    function _callAndParseStringReturn(address token, bytes memory data)
        private view returns (string memory)
    {
        (bool ok, bytes memory ret) = token.staticcall(data);
        if (!ok || ret.length == 0) return _toAsciiString(token);

        if (ret.length == 32) {
            bytes32 raw = abi.decode(ret, (bytes32));
            uint256 len = 0;
            while (len < 32 && raw[len] != 0) { len++; }
            bytes memory out = new bytes(len);
            for (uint256 i = 0; i < len; i++) { out[i] = raw[i]; }
            return string(out);
        } else {
            // assume string
            return abi.decode(ret, (string));
        }
    }

    function tokenSymbol(address token) internal view returns (string memory) {
        return _callAndParseStringReturn(token, abi.encodeWithSignature("symbol()"));
    }

    function tokenName(address token) internal view returns (string memory) {
        return _callAndParseStringReturn(token, abi.encodeWithSignature("name()"));
    }
}
