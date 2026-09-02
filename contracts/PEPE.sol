// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Plain ERC20. Supply goes to the deployer (the Terrarium "treasury" account seeds everyone else).
contract PEPE {
    string public constant name = "Pepe";
    string public constant symbol = "PEPE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance(uint256 requested, uint256 available);
    error InsufficientAllowance(uint256 requested, uint256 available);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < value) revert InsufficientAllowance(value, allowed);
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        return _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) internal returns (bool) {
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance(value, bal);
        balanceOf[from] = bal - value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
