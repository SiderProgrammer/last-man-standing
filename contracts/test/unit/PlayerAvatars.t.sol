// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {PlayerAvatars} from "../../src/PlayerAvatars.sol";

contract PlayerAvatarsTest is Test {
    PlayerAvatars private avatars;

    address private constant OWNER = address(0xA11CE);
    address private constant ALICE = address(0xB0B);
    address private constant BOB = address(0xCAFE);

    string private constant BASE = "ipfs://bafyfake/";

    function setUp() public {
        avatars = new PlayerAvatars(OWNER, "LMS Avatars", "LMSA", 3, BASE);
    }

    function test_MintAssignsSequentialIdsAndEquips() public {
        vm.prank(ALICE);
        uint256 tokenId = avatars.mint();

        assertEq(tokenId, 1);
        assertEq(avatars.ownerOf(1), ALICE);
        assertEq(avatars.equipped(ALICE), 1);
        assertEq(avatars.totalMinted(), 1);

        vm.prank(BOB);
        assertEq(avatars.mint(), 2);
    }

    function test_AvatarOfReturnsTokenAndUri() public {
        vm.prank(ALICE);
        avatars.mint();

        (uint256 tokenId, string memory uri) = avatars.avatarOf(ALICE);
        assertEq(tokenId, 1);
        assertEq(uri, "ipfs://bafyfake/1");
    }

    /// @dev Every consumer has to handle "no avatar", so it must not revert.
    function test_AvatarOfIsEmptyForAWalletWithoutOne() public view {
        (uint256 tokenId, string memory uri) = avatars.avatarOf(BOB);
        assertEq(tokenId, 0);
        assertEq(bytes(uri).length, 0);
    }

    function test_MintIsOncePerWallet() public {
        vm.startPrank(ALICE);
        avatars.mint();
        vm.expectRevert(abi.encodeWithSelector(PlayerAvatars.AlreadyMinted.selector, ALICE));
        avatars.mint();
        vm.stopPrank();
    }

    function test_MintStopsAtMaxSupply() public {
        vm.prank(address(0x1));
        avatars.mint();
        vm.prank(address(0x2));
        avatars.mint();
        vm.prank(address(0x3));
        avatars.mint();

        vm.prank(address(0x4));
        vm.expectRevert(PlayerAvatars.SoldOut.selector);
        avatars.mint();
    }

    function test_EquipRequiresOwnership() public {
        vm.prank(ALICE);
        avatars.mint();

        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(PlayerAvatars.NotOwner.selector, BOB, 1));
        avatars.equip(1);
    }

    function test_EquipChoosesBetweenOwnedAvatars() public {
        vm.prank(ALICE);
        avatars.mint();
        vm.prank(BOB);
        avatars.mint();

        // Bob hands his over; Alice now holds two and keeps wearing her own.
        vm.prank(BOB);
        avatars.transferFrom(BOB, ALICE, 2);
        assertEq(avatars.equipped(ALICE), 1);

        vm.prank(ALICE);
        avatars.equip(2);
        assertEq(avatars.equipped(ALICE), 2);
    }

    /// @dev The whole point of clearing on transfer: `avatarOf` must never name
    ///      a token the wallet has sold.
    function test_TransferClearsTheSendersEquippedSlot() public {
        vm.prank(ALICE);
        avatars.mint();
        assertEq(avatars.equipped(ALICE), 1);

        vm.prank(ALICE);
        avatars.transferFrom(ALICE, BOB, 1);

        assertEq(avatars.equipped(ALICE), 0);
        (uint256 tokenId,) = avatars.avatarOf(ALICE);
        assertEq(tokenId, 0);
        // And the recipient, who had nothing, now wears it.
        assertEq(avatars.equipped(BOB), 1);
    }

    function test_UnequipKeepsTheToken() public {
        vm.startPrank(ALICE);
        avatars.mint();
        avatars.unequip();
        vm.stopPrank();

        assertEq(avatars.equipped(ALICE), 0);
        assertEq(avatars.ownerOf(1), ALICE);
    }

    function test_TokenUriFollowsTheBaseUri() public {
        vm.prank(ALICE);
        avatars.mint();

        vm.prank(OWNER);
        avatars.setBaseUri("ipfs://bafyreal/");
        assertEq(avatars.tokenURI(1), "ipfs://bafyreal/1");
    }

    function test_TokenUriRevertsForAnUnmintedToken() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        avatars.tokenURI(99);
    }

    function test_OnlyOwnerSetsTheBaseUri() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ALICE));
        avatars.setBaseUri("ipfs://hijack/");
    }
}
