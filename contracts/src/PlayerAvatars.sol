// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title PlayerAvatars
/// @notice Cosmetic avatars worn by seats in the arena.
///
/// @dev Deployed independently on the hub and on every spoke, so a player mints
///      on the chain they already play from and never has to bridge to look
///      like themselves. Nothing here is cross-chain: each deployment is its
///      own collection with its own supply, and the server reads whichever one
///      matches the chain a seat staked from.
///
///      Strictly cosmetic, and deliberately outside consensus. No part of this
///      contract feeds the commit hash, the round hashes, the history root or
///      the rules hash — the engine cannot see an avatar, a replay does not
///      need one, and settlement is identical whether a player wears one or
///      not. A cosmetic that could change a result would be pay-to-win; a
///      cosmetic that entered the hash chain would break replay for anyone who
///      did not also hold the token metadata.
contract PlayerAvatars is ERC721, Ownable {
    using Strings for uint256;

    /// @notice Hard ceiling on the collection, fixed at deployment.
    uint256 public immutable maxSupply;

    /// @notice Tokens minted so far. Also the next token id, since ids start at 1.
    uint256 public totalMinted;

    /// @notice Metadata prefix, typically `ipfs://<cid>/`.
    string private baseUri;

    /// @notice The token a wallet currently wears. Zero means none.
    /// @dev Kept explicitly rather than derived: a wallet may hold several
    ///      avatars, and the arena has room for exactly one.
    mapping(address owner => uint256 tokenId) public equipped;

    /// @notice Whether a wallet has used its free mint.
    mapping(address minter => bool) public hasMinted;

    event BaseUriSet(string baseUri);
    event Minted(address indexed to, uint256 indexed tokenId);
    event Equipped(address indexed owner, uint256 indexed tokenId);

    error SoldOut();
    error AlreadyMinted(address minter);
    error NotOwner(address caller, uint256 tokenId);

    constructor(
        address owner_,
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        string memory baseUri_
    ) ERC721(name_, symbol_) Ownable(owner_) {
        maxSupply = maxSupply_;
        baseUri = baseUri_;
        emit BaseUriSet(baseUri_);
    }

    /// @notice Mints the caller's avatar and equips it if they had none.
    /// @dev One per wallet, free. The supply cap is what makes the art finite;
    ///      the per-wallet cap is what stops one wallet taking all of it.
    function mint() external returns (uint256 tokenId) {
        if (hasMinted[msg.sender]) revert AlreadyMinted(msg.sender);
        if (totalMinted >= maxSupply) revert SoldOut();

        hasMinted[msg.sender] = true;
        tokenId = ++totalMinted;
        _safeMint(msg.sender, tokenId);

        emit Minted(msg.sender, tokenId);
    }

    /// @notice Chooses which owned avatar to wear.
    function equip(uint256 tokenId) external {
        if (_ownerOf(tokenId) != msg.sender) revert NotOwner(msg.sender, tokenId);
        equipped[msg.sender] = tokenId;
        emit Equipped(msg.sender, tokenId);
    }

    /// @notice Stops wearing an avatar without transferring it.
    function unequip() external {
        delete equipped[msg.sender];
        emit Equipped(msg.sender, 0);
    }

    /// @notice The avatar a seat should be drawn with, and where its metadata lives.
    /// @dev One call per seat is all the server needs, so it returns the URI
    ///      rather than making the caller follow up with `tokenURI`. Returns
    ///      `(0, "")` for a wallet with no avatar, which every caller must
    ///      handle anyway: an avatar is optional and a match never waits on one.
    function avatarOf(address player) external view returns (uint256 tokenId, string memory uri) {
        tokenId = equipped[player];
        if (tokenId == 0) return (0, "");
        return (tokenId, tokenURI(tokenId));
    }

    function setBaseUri(string calldata newBaseUri) external onlyOwner {
        baseUri = newBaseUri;
        emit BaseUriSet(newBaseUri);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(baseUri, tokenId.toString());
    }

    /// @dev Clears the sender's equipped slot when that token leaves, so
    ///      `avatarOf` can never name a token the wallet no longer owns.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && equipped[from] == tokenId) {
            delete equipped[from];
            emit Equipped(from, 0);
        }
        // A wallet minting its first avatar wears it without a second
        // transaction. Only on mint: a transfer must not dress a wallet in
        // something it never chose — anyone can send anyone an NFT, and the
        // arena would show it on their seat. Received avatars wait for `equip`.
        if (from == address(0) && to != address(0) && equipped[to] == 0) {
            equipped[to] = tokenId;
            emit Equipped(to, tokenId);
        }
    }
}
