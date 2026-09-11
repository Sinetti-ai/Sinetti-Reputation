// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @notice The subset of the ERC-8004 Identity Registry the publisher touches.
 * @dev Not a reference implementation and not a substitute for one. It exists
 *      so the publisher's agentId binding checks can be exercised against real
 *      EVM behaviour (a reverting `getAgentWallet` on an unset wallet, a
 *      reverting `ownerOf` on an unminted id) rather than against a stub that
 *      politely returns zero. Those reverts are the cases the publisher has to
 *      survive, so a mock that cannot produce them proves nothing.
 *
 *      Only the ERC-721 surface the publisher calls is implemented. Pulling in
 *      a full ERC721 would drag the project's solc past 0.8.20 and change the
 *      bytecode of the real contracts beside it, to add transfer machinery no
 *      test here exercises.
 */
contract MockIdentityRegistry {
    uint256 private _nextAgentId = 1;
    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) private _agentWallets;
    mapping(uint256 => address) private _approved;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _nextAgentId++;
        _owners[agentId] = msg.sender;
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(ownerOf(agentId) == msg.sender, "not owner");
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function ownerOf(uint256 agentId) public view returns (address) {
        address owner = _owners[agentId];
        require(owner != address(0), "nonexistent agent");
        return owner;
    }

    function setAgentWallet(uint256 agentId, address newWallet) external {
        require(ownerOf(agentId) == msg.sender, "not owner");
        _agentWallets[agentId] = newWallet;
    }

    function getApproved(uint256 agentId) external view returns (address) {
        ownerOf(agentId);
        return _approved[agentId];
    }

    function approve(address to, uint256 agentId) external {
        require(ownerOf(agentId) == msg.sender, "not owner");
        _approved[agentId] = to;
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        address wallet = _agentWallets[agentId];
        require(wallet != address(0), "wallet unset");
        return wallet;
    }
}

/**
 * @notice The subset of the ERC-8004 Reputation Registry the publisher writes to.
 * @dev Mirrors the two properties the publisher depends on and would otherwise
 *      only be asserted in a comment: `endpoint`, `feedbackURI` and
 *      `feedbackHash` are emitted and never stored, and the spec's rule that
 *      "the feedback submitter MUST NOT be the agent owner or an approved
 *      operator" is enforced by reverting. Storing only what the real registry
 *      stores is what makes a test able to show the URI has no on-chain home.
 */
contract MockReputationRegistry {
    struct StoredFeedback {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bool isRevoked;
    }

    MockIdentityRegistry public immutable identityRegistry;
    mapping(uint256 => mapping(address => StoredFeedback[])) private _feedback;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    constructor(MockIdentityRegistry registry) {
        identityRegistry = registry;
    }

    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }

    struct FeedbackInput {
        uint256 agentId;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
    }

    /**
     * @dev Takes a struct rather than eight parameters for the same reason
     *      SinettiEscrowV04 does it: eleven event arguments plus eight locals
     *      overflow the EVM stack, and `--via-ir` for one mock is not worth
     *      changing how every contract in the project compiles.
     */
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        require(identityRegistry.ownerOf(agentId) != msg.sender, "self feedback");
        _record(
            FeedbackInput({
                agentId: agentId,
                value: value,
                valueDecimals: valueDecimals,
                tag1: tag1,
                tag2: tag2,
                endpoint: endpoint,
                feedbackURI: feedbackURI,
                feedbackHash: feedbackHash
            })
        );
    }

    function _record(FeedbackInput memory input) private {
        _feedback[input.agentId][msg.sender].push(
            StoredFeedback({
                value: input.value,
                valueDecimals: input.valueDecimals,
                tag1: input.tag1,
                tag2: input.tag2,
                isRevoked: false
            })
        );
        emit NewFeedback(
            input.agentId,
            msg.sender,
            // The reference registry numbers feedback from 1 per (agentId, client).
            uint64(_feedback[input.agentId][msg.sender].length),
            input.value,
            input.valueDecimals,
            input.tag1,
            input.tag1,
            input.tag2,
            input.endpoint,
            input.feedbackURI,
            input.feedbackHash
        );
    }

    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        _feedback[agentId][msg.sender][feedbackIndex - 1].isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        StoredFeedback storage stored = _feedback[agentId][clientAddress][feedbackIndex - 1];
        return (stored.value, stored.valueDecimals, stored.tag1, stored.tag2, stored.isRevoked);
    }

    function feedbackCount(uint256 agentId, address clientAddress) external view returns (uint256) {
        return _feedback[agentId][clientAddress].length;
    }
}
