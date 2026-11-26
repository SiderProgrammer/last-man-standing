// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {LmsToken} from "../src/governance/LmsToken.sol";
import {LmsFaucet} from "../src/governance/LmsFaucet.sol";

/// @notice Testnet only: collects LMS for one address from the faucet, which
///         pays each address once, by dripping to throwaway addresses and
///         forwarding their liquid LMS to it.
/// @dev Each round drips to a throwaway address, has it sign an LMS `permit`
///      for the payer, and moves its liquid LMS with `transferFrom`. Only the
///      payer sends transactions, so the throwaway addresses need no ETH. The
///      faucet's staked share stays with each throwaway address, voting for
///      itself.
///
///      The throwaway keys come from `AIRDROP_SEED`, so the same seed always
///      gives the same addresses. That makes a rerun resume: an address the
///      faucet already paid is not dripped again, and one already emptied is
///      skipped. Keep the seed secret: its keys hold the staked LMS.
///
///      Environment:
///        DEPLOYER_PK      pays the gas; sends every transaction
///        AIRDROP_SEED     secret; derives the throwaway keys
///        AIRDROP_TO       receives the LMS
///        AIRDROP_AMOUNT   LMS to collect, in wei; defaults to 900,000 LMS,
///                         and must be a whole number of liquid scoops
contract FaucetAirdrop is Script {
    /// @dev secp256k1's group order: a private key must be below it.
    uint256 private constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// @dev Held in storage rather than as locals: `run` is at the stack limit.
    LmsFaucet private _faucet;
    LmsToken private _lms;
    uint256 private _seed;
    address private _payer;
    address private _to;

    error NoFaucet(uint256 chainId);
    error UnevenAmount(uint256 amount, uint256 liquidAmount);
    error NotEnoughScoops(uint256 needed, uint256 left);
    error TransferFailed(address from);

    function run() external {
        uint256 payerKey = vm.envUint("DEPLOYER_PK");
        _payer = vm.addr(payerKey);
        _seed = vm.envUint("AIRDROP_SEED");
        _to = vm.envAddress("AIRDROP_TO");
        uint256 amount = vm.envOr("AIRDROP_AMOUNT", uint256(900_000e18));

        string memory registry = vm.readFile(
            string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json")
        );
        if (!vm.keyExistsJson(registry, ".contracts.lmsFaucet")) revert NoFaucet(block.chainid);
        _faucet = LmsFaucet(vm.parseJsonAddress(registry, ".contracts.lmsFaucet"));
        _lms = LmsToken(address(_faucet.lms()));

        uint256 liquid = _faucet.liquidAmount();
        if (amount == 0 || amount % liquid != 0) revert UnevenAmount(amount, liquid);
        uint256 rounds = amount / liquid;

        uint256 needed;
        for (uint256 i; i < rounds; ++i) {
            if (!_faucet.dripped(vm.addr(_key(i)))) ++needed;
        }
        uint256 left = _faucet.scoopsLeft();
        if (needed > left) revert NotEnoughScoops(needed, left);

        uint256 before = _lms.balanceOf(_to);
        vm.startBroadcast(payerKey);
        for (uint256 i; i < rounds; ++i) {
            _round(_key(i));
        }
        vm.stopBroadcast();

        console.log("rounds          ", rounds);
        console.log("new drips       ", needed);
        console.log("LMS sent to     ", _to);
        console.log("received (LMS)  ", (_lms.balanceOf(_to) - before) / 1e18);
        console.log("balance (LMS)   ", _lms.balanceOf(_to) / 1e18);
        console.log("scoops left     ", _faucet.scoopsLeft());
    }

    /// @dev Drips to `key`'s address unless the faucet already paid it, then
    ///      moves all its LMS to `_to`: a permit it signs for the payer, then
    ///      the payer's `transferFrom`.
    function _round(uint256 key) private {
        address holder = vm.addr(key);
        if (!_faucet.dripped(holder)) _faucet.drip(holder);

        uint256 balance = _lms.balanceOf(holder);
        if (balance == 0) return;
        uint256 deadline = block.timestamp + 1 days;
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, holder, _payer, balance, _lms.nonces(holder), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _lms.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        _lms.permit(holder, _payer, balance, deadline, v, r, s);
        if (!_lms.transferFrom(holder, _to, balance)) revert TransferFailed(holder);
    }

    /// @dev The `i`th throwaway key: in [1, n), as a private key must be.
    function _key(uint256 i) private view returns (uint256) {
        return uint256(keccak256(abi.encode(_seed, i))) % (SECP256K1_N - 1) + 1;
    }
}
