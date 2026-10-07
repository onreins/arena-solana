// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Local stand-ins for the agent-economy contracts.
 *
 * Test scaffolding for a local node; nothing here ships. The ERC-8004
 * registries (v2.0.0) are live on Arc testnet and mainnet, and the mocks for
 * them below copy the reference behaviour, so local tests fail the way the
 * real registries would. The real deployments are addressed by configuration.
 *
 * Interfaces follow EIP-8183 and EIP-8004 as published.
 */

// ---------------------------------------------------------------------------
// Minimal USDC, in its 6-decimal ERC-20 form (how ERC-8183 moves value).
// ---------------------------------------------------------------------------

contract MockUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @dev Real USDC can blocklist an address, after which transfers to it
    ///      revert. An escrow contract has to survive that happening mid-job.
    mapping(address => bool) public blocked;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error Blocked();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setBlocked(address who, bool isBlocked) external {
        blocked[who] = isBlocked;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        if (blocked[from] || blocked[to]) revert Blocked();
        require(balanceOf[from] >= amount, "balance");
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

// ---------------------------------------------------------------------------
// ERC-8183: Agentic Commerce
// ---------------------------------------------------------------------------

contract MockAgenticCommerce {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
    }

    MockUSDC public immutable token;
    uint256 public nextJobId = 1;

    mapping(uint256 => Job) private _jobs;
    mapping(uint256 => bytes32) public deliverableOf;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt,
        address hook
    );
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    error NotClient();
    error NotProvider();
    error NotEvaluator();
    error BadStatus();
    error Expired();

    constructor(MockUSDC token_) {
        token = token_;
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
        jobId = nextJobId++;
        _jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            provider: provider,
            evaluator: evaluator,
            description: description,
            budget: 0,
            expiredAt: expiredAt,
            status: JobStatus.Open,
            hook: hook
        });
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
    }

    /// @dev The provider quotes the job.
    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.provider) revert NotProvider();
        if (job.status != JobStatus.Open) revert BadStatus();
        job.budget = amount;
    }

    /// @dev The client escrows the quoted budget.
    function fund(uint256 jobId, bytes calldata) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert NotClient();
        if (job.status != JobStatus.Open) revert BadStatus();

        require(token.transferFrom(msg.sender, address(this), job.budget), "transferFrom");
        job.status = JobStatus.Funded;
        emit JobFunded(jobId, msg.sender, job.budget);
    }

    /// @dev The provider commits to a deliverable. The hash binds the content:
    ///      whatever is served off-chain must hash to this, or it is not the
    ///      thing that was submitted.
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.provider) revert NotProvider();
        if (job.status != JobStatus.Funded) revert BadStatus();
        if (block.timestamp > job.expiredAt) revert Expired();

        deliverableOf[jobId] = deliverable;
        job.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.evaluator) revert NotEvaluator();
        if (job.status != JobStatus.Submitted) revert BadStatus();

        job.status = JobStatus.Completed;
        require(token.transfer(job.provider, job.budget), "transfer");

        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, job.provider, job.budget);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.evaluator) revert NotEvaluator();
        if (job.status != JobStatus.Submitted) revert BadStatus();

        job.status = JobStatus.Rejected;
        emit JobRejected(jobId, msg.sender, reason);
    }

    function claimRefund(uint256 jobId) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert NotClient();

        if (job.status == JobStatus.Funded && block.timestamp > job.expiredAt) {
            job.status = JobStatus.Expired;
            emit JobExpired(jobId);
        }
        if (job.status != JobStatus.Rejected && job.status != JobStatus.Expired) {
            revert BadStatus();
        }

        uint256 amount = job.budget;
        job.budget = 0;
        require(token.transfer(job.client, amount), "transfer");
        emit Refunded(jobId, job.client, amount);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }
}

// ---------------------------------------------------------------------------
// ERC-8004: IdentityRegistry (the ERC-721 parts other contracts read)
// ---------------------------------------------------------------------------

/**
 * @notice Agents as ERC-721 tokens: an owner, a per-token approval and
 *         operators. The reference v2.0.0 numbers agents from 0 on `register`;
 *         `mint` lets a test pick an id.
 */
contract MockIdentityRegistry {
    uint256 private _nextId;
    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error ERC721NonexistentToken(uint256 tokenId);
    error ERC721InvalidApprover(address approver);
    error TokenExists(uint256 tokenId);

    /// @dev Like the reference: the next free id, minted to the sender.
    function register() external returns (uint256 agentId) {
        while (_owners[_nextId] != address(0)) _nextId++;
        agentId = _nextId++;
        _mintTo(msg.sender, agentId);
    }

    function mint(address to, uint256 agentId) external {
        if (_owners[agentId] != address(0)) revert TokenExists(agentId);
        _mintTo(to, agentId);
    }

    function transferFrom(address from, address to, uint256 agentId) external {
        address owner = ownerOf(agentId);
        require(from == owner, "from");
        require(
            msg.sender == owner || _operatorApprovals[owner][msg.sender] || _tokenApprovals[agentId] == msg.sender,
            "not approved"
        );
        delete _tokenApprovals[agentId];
        _owners[agentId] = to;
        emit Transfer(from, to, agentId);
    }

    function ownerOf(uint256 agentId) public view returns (address owner) {
        owner = _owners[agentId];
        if (owner == address(0)) revert ERC721NonexistentToken(agentId);
    }

    function approve(address to, uint256 agentId) external {
        address owner = ownerOf(agentId);
        if (msg.sender != owner && !_operatorApprovals[owner][msg.sender]) revert ERC721InvalidApprover(msg.sender);
        _tokenApprovals[agentId] = to;
        emit Approval(owner, to, agentId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function getApproved(uint256 agentId) external view returns (address) {
        ownerOf(agentId);
        return _tokenApprovals[agentId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function _mintTo(address to, uint256 agentId) private {
        require(to != address(0), "zero owner");
        _owners[agentId] = to;
        emit Transfer(address(0), to, agentId);
    }
}

// ---------------------------------------------------------------------------
// ERC-8004: ValidationRegistry, as the reference v2.0.0 behaves
// ---------------------------------------------------------------------------

interface IMockIdentityRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

/**
 * @notice Mirrors erc-8004-contracts ValidationRegistryUpgradeable v2.0.0
 *         (the version live on Arc), minus the proxy: the same checks, the
 *         same revert strings, the same storage semantics.
 *
 *   - only the agent's owner or an approved operator may request, and each
 *     requestHash can be used once
 *   - only the named validator may respond, 0 to 100, as often as it likes;
 *     the latest response is stored and every one is emitted
 *   - `lastUpdate` is a timestamp, not a block number
 */
contract MockValidationRegistry {
    struct ValidationStatus {
        address validatorAddress;
        uint256 agentId;
        uint8 response; // 0..100
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
        bool hasResponse;
    }

    address private immutable _identityRegistry;

    mapping(bytes32 => ValidationStatus) private _validations;
    mapping(uint256 => bytes32[]) private _agentValidations;
    mapping(address => bytes32[]) private _validatorRequests;

    event ValidationRequest(
        address indexed validatorAddress,
        uint256 indexed agentId,
        string requestURI,
        bytes32 indexed requestHash
    );
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    constructor(address identityRegistry_) {
        require(identityRegistry_ != address(0), "bad identity");
        _identityRegistry = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    function getVersion() external pure returns (string memory) {
        return "2.0.0";
    }

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        require(validatorAddress != address(0), "bad validator");
        require(_validations[requestHash].validatorAddress == address(0), "exists");

        IMockIdentityRegistry registry = IMockIdentityRegistry(_identityRegistry);
        address owner = registry.ownerOf(agentId);
        require(
            msg.sender == owner ||
                registry.isApprovedForAll(owner, msg.sender) ||
                registry.getApproved(agentId) == msg.sender,
            "Not authorized"
        );

        _validations[requestHash] = ValidationStatus({
            validatorAddress: validatorAddress,
            agentId: agentId,
            response: 0,
            responseHash: bytes32(0),
            tag: "",
            lastUpdate: block.timestamp,
            hasResponse: false
        });
        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);

        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        ValidationStatus storage s = _validations[requestHash];
        require(s.validatorAddress != address(0), "unknown");
        require(msg.sender == s.validatorAddress, "not validator");
        require(response <= 100, "resp>100");
        s.response = response;
        s.responseHash = responseHash;
        s.tag = tag;
        s.lastUpdate = block.timestamp;
        s.hasResponse = true;
        emit ValidationResponse(s.validatorAddress, s.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        ValidationStatus memory s = _validations[requestHash];
        require(s.validatorAddress != address(0), "unknown");
        return (s.validatorAddress, s.agentId, s.response, s.responseHash, s.tag, s.lastUpdate);
    }

    /// @dev Count and average of answered requests, optionally filtered by
    ///      validator and tag (empty filters match everything).
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse)
    {
        uint256 totalResponse;
        bytes32[] storage requestHashes = _agentValidations[agentId];

        for (uint256 i; i < requestHashes.length; i++) {
            ValidationStatus storage s = _validations[requestHashes[i]];

            bool matchValidator = (validatorAddresses.length == 0);
            if (!matchValidator) {
                for (uint256 j; j < validatorAddresses.length; j++) {
                    if (s.validatorAddress == validatorAddresses[j]) {
                        matchValidator = true;
                        break;
                    }
                }
            }
            bool matchTag = (bytes(tag).length == 0) || (keccak256(bytes(s.tag)) == keccak256(bytes(tag)));

            if (matchValidator && matchTag && s.hasResponse) {
                totalResponse += s.response;
                count++;
            }
        }
        avgResponse = count > 0 ? uint8(totalResponse / count) : 0;
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }
}

// ---------------------------------------------------------------------------
// A hostile ERC-8183 hook
// ---------------------------------------------------------------------------

interface ICommerce {
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
}

/**
 * @notice A hook that tries to re-enter the escrow from inside another call.
 *
 * An audit pointed out that a reentrancy mutex only blocks re-entering a lock
 * that is already engaged. If a state-changing function is left unguarded, the
 * hook it fires can call a guarded function for the first time in the stack and
 * sail straight through — paying out, and then having the outer call overwrite
 * the status afterwards.
 *
 * This reproduces that: it is installed as the hook on a job whose evaluator is
 * this same contract, and when `reject` fires its before-hook it calls
 * `complete` on the way past.
 */
contract ReenteringHook {
    ICommerce public immutable commerce;
    uint256 public jobId;
    bool public armed;
    bool public fired;

    constructor(ICommerce commerce_) {
        commerce = commerce_;
    }

    function arm(uint256 jobId_) external {
        jobId = jobId_;
        armed = true;
        fired = false;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external {
        if (!armed || fired) return;
        fired = true;
        commerce.complete(jobId, bytes32(uint256(0xdead)), "");
    }

    function afterAction(uint256, bytes4, bytes calldata) external {}

    /// @dev Lets this contract act as evaluator and call reject itself.
    function rejectVia(address target, uint256 jobId_, bytes32 reason) external {
        (bool ok, bytes memory data) = target.call(
            abi.encodeWithSignature("reject(uint256,bytes32,bytes)", jobId_, reason, "")
        );
        if (!ok) {
            assembly {
                revert(add(data, 32), mload(data))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// ERC-1271: a contract wallet that signs through its owner's key
// ---------------------------------------------------------------------------

/**
 * @notice The smallest smart-contract account: a signature is valid when its
 *         owner's key made it. The owner can switch it off, as a real wallet
 *         can revoke, to show a contract signature is checked live.
 */
contract MockERC1271Wallet {
    bytes4 private constant MAGIC = 0x1626ba7e; // isValidSignature.selector
    address public immutable owner;
    bool public disabled;

    constructor(address owner_) {
        owner = owner_;
    }

    function setDisabled(bool disabled_) external {
        require(msg.sender == owner, "owner");
        disabled = disabled_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (disabled || signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return 0xffffffff;
        address signer = ecrecover(hash, v, r, s);
        return signer != address(0) && signer == owner ? MAGIC : bytes4(0xffffffff);
    }
}
