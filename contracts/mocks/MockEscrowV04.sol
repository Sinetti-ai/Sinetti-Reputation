// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice The V04 settlement vocabulary, as an indexer test fixture.
 *
 * @dev Not a reference implementation and not a substitute for one. The real
 *      contract is `contracts/SinettiEscrowV04.sol` in Sinetti-Escrow; this exists only so
 *      `sinetti-rep` can produce genuine V04 logs on a local chain without
 *      taking a dependency on Sinetti-Escrow.
 *
 *      It is deliberately NOT a port. The real V04 needs solc 0.8.26 and pins
 *      OpenZeppelin at exactly 5.0.2 for a Berlin-fork compatibility issue,
 *      while this project is on 0.8.20 with a floating OZ. Bumping the pragma
 *      here would change the bytecode of every contract in this package, so the
 *      fixture comes to the compiler rather than the other way round.
 *
 *      What it does guarantee is the part the indexer reads: the seven event
 *      signatures below match `src/abi.ts` `SINETTI_ESCROW_V04_ABI` field for
 *      field, and `test/abi.parity.test.ts` fails if they ever drift. What it
 *      deliberately does NOT reproduce is the real contract's authorisation,
 *      EIP-712 acceptance, windows arithmetic, or state-machine enforcement:
 *      any caller may drive any transition here. Those properties are tested in
 *      Sinetti-Escrow, against the contract that actually has them. Do not read a
 *      passing test here as evidence about escrow behaviour.
 */
contract MockEscrowV04 {
    event DealOpened(
        uint256 indexed dealId,
        address indexed buyer,
        address indexed seller,
        address verifier,
        address arbitrator,
        address token,
        uint256 amount,
        uint256 bond,
        uint256 challengerBond,
        bytes32 termsHash,
        bytes32 buyerIdentityRef,
        bytes32 sellerIdentityRef,
        bytes32 verifierIdentityRef,
        bytes32 arbitratorIdentityRef,
        uint64 deadline,
        uint64 challengeWindow,
        uint64 rulingWindow
    );
    event DealParties(uint256 indexed dealId, address indexed verifier, address indexed arbitrator);
    event BondPosted(uint256 indexed dealId, uint256 bond);
    event BondSlashed(uint256 indexed dealId, uint256 bond);
    event Challenged(uint256 indexed dealId, address indexed challenger, uint256 challengerBond, uint64 rulingDeadline);
    event VerificationRecorded(
        uint256 indexed dealId,
        address indexed verifier,
        uint8 verdict,
        uint64 verifiedAt,
        uint64 challengeEndsAt
    );
    event Settled(uint256 indexed dealId, bytes32 indexed reason, uint256 sellerCredit, uint256 buyerCredit);

    struct Deal {
        address buyer;
        address seller;
        address token;
        uint256 amount;
        uint256 bond;
        uint64 deadline;
        bool bondPosted;
        bool settled;
    }

    /// @dev Mirrors the real contract's 1-based ids so `nextDealId() - 1` reads the same.
    uint256 public nextDealId = 1;
    mapping(uint256 => Deal) public deals;

    struct OpenParams {
        address seller;
        address verifier;
        address arbitrator;
        address token;
        uint256 amount;
        uint256 bond;
        uint256 challengerBond;
        bytes32 termsHash;
        uint64 deadline;
        uint64 challengeWindow;
        uint64 rulingWindow;
    }

    /// @dev Takes a struct because a 17-field event plus locals overflows the stack on 0.8.20.
    function openDeal(OpenParams calldata params) external returns (uint256 dealId) {
        dealId = nextDealId++;
        deals[dealId] = Deal({
            buyer: msg.sender,
            seller: params.seller,
            token: params.token,
            amount: params.amount,
            bond: params.bond,
            deadline: params.deadline,
            bondPosted: false,
            settled: false
        });
        IERC20(params.token).transferFrom(msg.sender, address(this), params.amount);
        emit DealOpened(
            dealId,
            msg.sender,
            params.seller,
            params.verifier,
            params.arbitrator,
            params.token,
            params.amount,
            params.bond,
            params.challengerBond,
            params.termsHash,
            // The four identity anchors. Zero here for the same reason they are
            // zero on the live deployment: the A4 record they resolve to is
            // published off-chain, and nothing yet writes one.
            bytes32(0),
            bytes32(0),
            bytes32(0),
            bytes32(0),
            params.deadline,
            params.challengeWindow,
            params.rulingWindow
        );
        emit DealParties(dealId, params.verifier, params.arbitrator);
    }

    function postBond(uint256 dealId) external {
        Deal storage deal = deals[dealId];
        deal.bondPosted = true;
        IERC20(deal.token).transferFrom(msg.sender, address(this), deal.bond);
        emit BondPosted(dealId, deal.bond);
    }

    /**
     * @dev V04 emits no delivery event — `submitDelivery` moves state and the
     *      evidence hash lives in the signed terms. Kept as a no-op call so a
     *      test can drive the same sequence a real deal follows, and so the
     *      absence of a log here is explicit rather than an oversight.
     */
    // solhint-disable-next-line no-empty-blocks
    function submitDelivery(uint256 dealId, bytes32 evidenceHash) external {}

    function recordVerification(uint256 dealId, uint8 verdict, uint64 challengeEndsAt) external {
        emit VerificationRecorded(dealId, msg.sender, verdict, uint64(block.timestamp), challengeEndsAt);
    }

    function challenge(uint256 dealId, uint256 challengerBond, uint64 rulingDeadline) external {
        emit Challenged(dealId, msg.sender, challengerBond, rulingDeadline);
    }

    /**
     * @dev The one settlement entry point. `reason` is the readable ASCII the
     *      aggregator decodes — `accepted`, `verdict_pass`, `verdict_fail`,
     *      `verdict_inconclusive`, `ruling_release`, `ruling_refund`,
     *      `ruling_lapsed`, `timeout`, `cancelled`. `slashBond` is separate from
     *      the reason because the aggregator anchors a slash on the BondSlashed
     *      log rather than on the reason alone, so a test must be able to
     *      produce `ruling_refund` with and without one.
     */
    function settle(uint256 dealId, bytes32 reason, bool slashBond) external {
        Deal storage deal = deals[dealId];
        require(!deal.settled, "settled");
        deal.settled = true;
        if (slashBond && deal.bondPosted) emit BondSlashed(dealId, deal.bond);
        bool toSeller = reason == "accepted" || reason == "verdict_pass" || reason == "ruling_release";
        uint256 sellerCredit = toSeller ? deal.amount : 0;
        uint256 buyerCredit = toSeller ? 0 : deal.amount;
        IERC20(deal.token).transfer(toSeller ? deal.seller : deal.buyer, deal.amount);
        emit Settled(dealId, reason, sellerCredit, buyerCredit);
    }

    /// @dev The deadline path. Refunds the buyer and settles with `timeout`.
    function claimTimeout(uint256 dealId) external {
        Deal storage deal = deals[dealId];
        require(!deal.settled, "settled");
        require(block.timestamp >= deal.deadline, "early");
        deal.settled = true;
        IERC20(deal.token).transfer(deal.buyer, deal.amount);
        emit Settled(dealId, "timeout", 0, deal.amount);
    }
}
