/**
 * The V04 vocabulary, as the reputation indexer needs it.
 *
 * Not the whole contract: the seven events below are the ones the deal
 * projection and the classifier read. The pause, pauser-transfer, evidence and
 * withdrawal events carry nothing reputation depends on, and five of them carry
 * no `dealId` at all, so indexing them would add rows that join to nothing.
 *
 * Signatures match `contracts/SinettiEscrowV04.sol` in Sinetti-Escrow field for field,
 * and `test/abi.parity.test.ts` pins `contracts/mocks/MockEscrowV04.sol` to
 * this list so the fixture cannot drift from what the indexer decodes.
 */
export const SINETTI_ESCROW_V04_ABI = [
  "event DealOpened(uint256 indexed dealId,address indexed buyer,address indexed seller,address verifier,address arbitrator,address token,uint256 amount,uint256 bond,uint256 challengerBond,bytes32 termsHash,bytes32 buyerIdentityRef,bytes32 sellerIdentityRef,bytes32 verifierIdentityRef,bytes32 arbitratorIdentityRef,uint64 deadline,uint64 challengeWindow,uint64 rulingWindow)",
  "event DealParties(uint256 indexed dealId,address indexed verifier,address indexed arbitrator)",
  "event BondPosted(uint256 indexed dealId,uint256 bond)",
  "event BondSlashed(uint256 indexed dealId,uint256 bond)",
  "event Challenged(uint256 indexed dealId,address indexed challenger,uint256 challengerBond,uint64 rulingDeadline)",
  "event VerificationRecorded(uint256 indexed dealId,address indexed verifier,uint8 verdict,uint64 verifiedAt,uint64 challengeEndsAt)",
  "event Settled(uint256 indexed dealId,bytes32 indexed reason,uint256 sellerCredit,uint256 buyerCredit)"
] as const;

export const ERC20_ABI = ["function decimals() view returns (uint8)"] as const;
