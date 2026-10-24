// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IAeroV2Token {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function approve(address,uint256) external returns (bool);
}
interface IAeroV2Morpho { function flashLoan(address,uint256,bytes calldata) external; }
interface IAeroV2Balancer { function flashLoan(address,address[] calldata,uint256[] calldata,bytes calldata) external; }
interface IAeroV2Pool {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    function tickSpacing() external view returns (int24);
    function fee() external view returns (uint24);
    function getAmountOut(uint256,address) external view returns (uint256);
    function getReserves() external view returns (uint256,uint256,uint256);
    function swap(uint256,uint256,address,bytes calldata) external;
}
interface IAeroV2ClassicFactory { function getPool(address,address,bool) external view returns (address); }
interface IAeroV2CLFactory { function getPool(address,address,int24) external view returns (address); }
interface IAeroV2UniV2Factory { function getPair(address,address) external view returns (address); }
interface IAeroV2UniV3Factory { function getPool(address,address,uint24) external view returns (address); }
interface IAeroV2CLPool { function swap(address,bool,int256,uint160,bytes calldata) external returns (int256,int256); }
struct AeroV4PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct AeroV4SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
interface IAeroV4Manager {
    function unlock(bytes calldata) external returns (bytes memory);
    function swap(AeroV4PoolKey memory,AeroV4SwapParams memory,bytes calldata) external returns (int256);
    function sync(address) external;
    function settle() external payable returns (uint256);
    function take(address,address,uint256) external;
}

/// @notice Successor artifact to AeroSplitFlashExecutor; V1 and its selectors are unchanged.
/// Venues: 2 Uniswap V2 (output computed on-chain), 3 Uniswap V3, 6 Aero classic,
/// 7 Slipstream, 8 Uniswap V4 (hookless, static fee, ERC20 only).
/// Lenders: 1 Morpho, 2 Balancer V2, 3 Uniswap V4 PoolManager (take/settle in one unlock).
///
///   Idle(0) --execute|quote--> Loan(1) --lender callback--> legs --> repay --> Settled(3) --> Idle(0)
///     CL leg:          Loan(1) -> Swap(2) --uniswapV3SwapCallback--> Loan(1)
///     V4 leg (lender!=V4 manager): Loan(1) -> Unlock(4) --unlockCallback swap/settle/take--> Loan(1)
///     V4 leg (lender==V4 manager): already unlocked; swap/settle/take inline
///   quote mode reverts AeroQuote(outs,fees) after the last leg, before any profit check.
contract AeroSplitFlashExecutorV2 {
    error Unauthorized(); error InvalidRoute(); error UntrustedRoot(); error CallbackOnly();
    error InsufficientOutput(); error Unprofitable(); error TransferFailed(); error Busy();
    error AeroQuote(uint256[] outputs,uint24[] fees);
    struct AeroLeg {
        uint8 venueVersion; address root; address pool; address tokenIn; address tokenOut;
        uint256 minAmountOut; uint24 fee; uint160 sqrtPriceLimitX96; int24 tickSpacing;
        bool stable; uint8 generation; address hooks;
    }
    struct AeroBranch { uint256 amountIn; AeroLeg[] legs; }
    struct AeroSplitRoute {
        uint8 kind; address lender; address flashAsset; uint256 flashAmount;
        AeroBranch[] branches; uint256 minProfit; uint256 deadline;
    }
    struct PoolPin { bytes32 runtimeHash; address implementation; bytes32 implementationHash; }
    struct V2Fee { bool configured; uint24 feePips; }
    uint24 private constant V4_DYNAMIC_FEE = 0x800000;
    address public immutable owner;
    // generation: 1 Aero classic, 2..4 Slipstream, 5 Uniswap V2, 6 Uniswap V3, 7 Uniswap V4 manager.
    mapping(uint8 => mapping(address => bytes32)) public trustedFactory;
    mapping(uint8 => mapping(address => bytes32)) public trustedLender;
    mapping(address => PoolPin) public trustedPool;
    mapping(address => uint256) public maxLenderFee;
    mapping(address => V2Fee) public v2Fee;
    mapping(bytes32 => bool) public trustedV4Pool;
    uint8 private phase;
    address private lender;
    uint8 private lenderKind;
    bytes32 private routeHash;
    uint256 private opening;
    bool private loanCompleted;
    bool private quoteMode;
    address private expectedPool;
    address private expectedInput;
    uint256 private expectedAmount;
    bool private expectedZeroForOne;
    bytes32 private swapHash;
    uint256 private swapOwed;
    event AeroArbitrageExecuted(bytes32 indexed routeHash,address indexed asset,uint256 principal,uint256 fee,uint256 profit,uint256 branches);
    event AeroLegExecuted(bytes32 indexed routeHash,uint256 indexed branchIndex,uint256 indexed legIndex,address pool,uint256 amountIn,uint256 amountOut);
    event RootConfigured(uint8 indexed generation,address indexed root,bytes32 codeHash);
    event PoolConfigured(address indexed pool,bytes32 runtimeHash,address implementation,bytes32 implementationHash);
    event V2FeeConfigured(address indexed root,uint24 feePips);
    event V4PoolConfigured(bytes32 indexed poolId,bool trusted);
    constructor() { owner=msg.sender; }
    modifier onlyOwner() { if(msg.sender!=owner)revert Unauthorized(); _; }
    modifier idle() { if(phase!=0)revert Busy(); _; }

    function configureFactory(uint8 generation,address root,bytes32 codeHash) external onlyOwner idle {
        if(generation<1||generation>7||root==address(0)||(codeHash!=0&&(root.code.length==0||root.codehash!=codeHash)))revert UntrustedRoot();
        trustedFactory[generation][root]=codeHash;emit RootConfigured(generation,root,codeHash);
    }
    function configurePool(address pool,bytes32 runtimeHash,address implementation,bytes32 implementationHash) external onlyOwner idle {
        if(pool==address(0))revert UntrustedRoot();
        if(runtimeHash!=0) {
            if(pool.code.length==0||pool.codehash!=runtimeHash||implementation.code.length==0||implementation.codehash!=implementationHash)revert UntrustedRoot();
            if(implementation!=pool&&!_isClone(pool,implementation))revert UntrustedRoot();
        }
        trustedPool[pool]=PoolPin(runtimeHash,implementation,implementationHash);
        emit PoolConfigured(pool,runtimeHash,implementation,implementationHash);
    }
    function configureLender(uint8 kind,address root,bytes32 codeHash,uint256 feeLimit) external onlyOwner idle {
        if(kind<1||kind>3||root==address(0)||(codeHash!=0&&(root.code.length==0||root.codehash!=codeHash))||(kind!=2&&feeLimit!=0))revert UntrustedRoot();
        trustedLender[kind][root]=codeHash;maxLenderFee[root]=feeLimit;
    }
    /// Uniswap V2-style factories charge a fixed input fee (pips of 1e6); unset factories cannot route.
    function configureV2Fee(address root,uint24 feePips,bool configured) external onlyOwner idle {
        if(root==address(0)||feePips>=1000000)revert UntrustedRoot();
        v2Fee[root]=V2Fee(configured,feePips);emit V2FeeConfigured(root,feePips);
    }
    function configureV4Pool(bytes32 poolId,bool trusted) external onlyOwner idle {
        if(poolId==0)revert UntrustedRoot();
        trustedV4Pool[poolId]=trusted;emit V4PoolConfigured(poolId,trusted);
    }
    function withdraw(address asset,uint256 amount,address recipient) external onlyOwner idle { if(recipient==address(0))revert InvalidRoute();_transfer(asset,recipient,amount); }

    function executeAeroSplitArbitrage(AeroSplitRoute calldata route) external onlyOwner idle returns(uint256 profit) {
        profit=_run(route,false);
    }
    /// Read-only ordered quote for eth_call: borrows, runs every leg, then always reverts AeroQuote.
    function quoteAeroSplit(AeroSplitRoute calldata route) external onlyOwner idle {
        _run(route,true);
        revert InvalidRoute();
    }
    function _run(AeroSplitRoute calldata route,bool quote) private returns(uint256 profit) {
        if(block.timestamp>route.deadline||route.flashAmount==0||route.flashAmount>uint256(type(int256).max)||route.minProfit==0||route.branches.length==0||route.branches.length>8||route.kind<1||route.kind>3)revert InvalidRoute();
        _pin(route.lender,trustedLender[route.kind][route.lender]);
        uint256 sum;
        for(uint256 i;i<route.branches.length;i++) {
            AeroBranch calldata branch=route.branches[i];
            if(branch.amountIn==0||branch.legs.length<2||branch.legs.length>6)revert InvalidRoute();
            sum+=branch.amountIn;address asset=route.flashAsset;
            for(uint256 j;j<branch.legs.length;j++){AeroLeg calldata leg=branch.legs[j];if(leg.tokenIn!=asset||leg.tokenIn==leg.tokenOut||leg.minAmountOut==0)revert InvalidRoute();_validate(leg);asset=leg.tokenOut;}
            if(asset!=route.flashAsset)revert InvalidRoute();
        }
        if(sum!=route.flashAmount)revert InvalidRoute();
        bytes memory data=abi.encode(route);routeHash=keccak256(data);lender=route.lender;lenderKind=route.kind;quoteMode=quote;
        opening=IAeroV2Token(route.flashAsset).balanceOf(address(this));loanCompleted=false;phase=1;
        if(route.kind==1)IAeroV2Morpho(route.lender).flashLoan(route.flashAsset,route.flashAmount,data);
        else if(route.kind==2){address[] memory assets=new address[](1);assets[0]=route.flashAsset;uint256[] memory amounts=new uint256[](1);amounts[0]=route.flashAmount;IAeroV2Balancer(route.lender).flashLoan(address(this),assets,amounts,data);}
        else IAeroV4Manager(route.lender).unlock(data);
        if(!loanCompleted||phase!=3||IAeroV2Token(route.flashAsset).balanceOf(address(this))<opening+route.minProfit)revert Unprofitable();
        profit=IAeroV2Token(route.flashAsset).balanceOf(address(this))-opening;
        if(route.kind==1)_approve(route.flashAsset,route.lender,0);
        phase=0;lender=address(0);routeHash=0;opening=0;loanCompleted=false;quoteMode=false;
    }
    function _authenticate(uint8 kind,bytes calldata data) private returns(AeroSplitRoute memory route) {
        if(phase!=1||loanCompleted||msg.sender!=lender||kind!=lenderKind||keccak256(data)!=routeHash)revert CallbackOnly();
        _pin(msg.sender,trustedLender[kind][msg.sender]);route=abi.decode(data,(AeroSplitRoute));loanCompleted=true;
    }
    function onMorphoFlashLoan(uint256 assets,bytes calldata data) external {
        AeroSplitRoute memory route=_authenticate(1,data);if(assets!=route.flashAmount)revert InvalidRoute();
        _execute(route,0);_approve(route.flashAsset,msg.sender,assets);phase=3;
    }
    function receiveFlashLoan(address[] calldata assets,uint256[] calldata amounts,uint256[] calldata fees,bytes calldata data) external {
        AeroSplitRoute memory route=_authenticate(2,data);
        if(assets.length!=1||amounts.length!=1||fees.length!=1||assets[0]!=route.flashAsset||amounts[0]!=route.flashAmount||fees[0]>maxLenderFee[msg.sender])revert InvalidRoute();
        _execute(route,fees[0]);_transfer(route.flashAsset,msg.sender,amounts[0]+fees[0]);phase=3;
    }
    /// Serves both the V4 lender (phase 1) and a single V4 swap leg (phase 4).
    function unlockCallback(bytes calldata data) external returns(bytes memory) {
        if(phase==4) {
            if(msg.sender!=expectedPool||keccak256(data)!=swapHash)revert CallbackOnly();
            (,AeroV4PoolKey memory key,bool zeroForOne,uint256 amount,uint160 limit)=abi.decode(data,(bytes32,AeroV4PoolKey,bool,uint256,uint160));
            uint256 out=_v4Swap(msg.sender,key,zeroForOne,amount,limit);
            phase=1;swapOwed=amount;return abi.encode(out);
        }
        AeroSplitRoute memory route=_authenticate(3,data);
        IAeroV4Manager(msg.sender).take(route.flashAsset,address(this),route.flashAmount);
        _execute(route,0);_v4Pay(msg.sender,route.flashAsset,route.flashAmount);phase=3;
        return bytes("");
    }
    function _execute(AeroSplitRoute memory route,uint256 fee) private {
        if(IAeroV2Token(route.flashAsset).balanceOf(address(this))!=opening+route.flashAmount)revert InvalidRoute();
        uint256 count;for(uint256 i;i<route.branches.length;i++)count+=route.branches[i].legs.length;
        uint256[] memory outputs=new uint256[](count);uint24[] memory fees=new uint24[](count);uint256 n;
        for(uint256 i;i<route.branches.length;i++) {
            uint256 amount=route.branches[i].amountIn;
            for(uint256 j;j<route.branches[i].legs.length;j++){
                AeroLeg memory leg=route.branches[i].legs[j];
                (uint256 next,uint24 legFee)=_swap(leg,amount);
                emit AeroLegExecuted(routeHash,i,j,leg.venueVersion==8?leg.root:leg.pool,amount,next);
                outputs[n]=next;fees[n++]=legFee;amount=next;
            }
        }
        if(quoteMode)revert AeroQuote(outputs,fees);
        uint256 closing=IAeroV2Token(route.flashAsset).balanceOf(address(this));
        if(closing<opening+route.flashAmount+fee+route.minProfit)revert Unprofitable();
        emit AeroArbitrageExecuted(routeHash,route.flashAsset,route.flashAmount,fee,closing-opening-route.flashAmount-fee,route.branches.length);
    }
    /// Runs once per leg before the loan; configuration cannot change mid-route (idle modifier).
    function _validate(AeroLeg calldata leg) private view {
        if(leg.tokenIn==address(0)||leg.tokenOut==address(0)||leg.root==address(0))revert InvalidRoute();
        (address t0,address t1)=leg.tokenIn<leg.tokenOut?(leg.tokenIn,leg.tokenOut):(leg.tokenOut,leg.tokenIn);
        if(leg.venueVersion==8) {
            if(leg.pool!=address(0)||leg.generation!=0||leg.stable||leg.hooks!=address(0)||leg.fee>=1000000||leg.fee==V4_DYNAMIC_FEE||leg.tickSpacing<=0||leg.sqrtPriceLimitX96==0)revert InvalidRoute();
            _pin(leg.root,trustedFactory[7][leg.root]);
            if(!trustedV4Pool[keccak256(abi.encode(AeroV4PoolKey(t0,t1,leg.fee,leg.tickSpacing,address(0))))])revert UntrustedRoot();
            return;
        }
        if(leg.hooks!=address(0))revert InvalidRoute();
        PoolPin memory pin=trustedPool[leg.pool];_pin(leg.pool,pin.runtimeHash);_pin(pin.implementation,pin.implementationHash);
        uint8 generation;
        if(leg.venueVersion==2){generation=5;if(leg.generation!=0||leg.stable||leg.fee!=0||leg.tickSpacing!=0||leg.sqrtPriceLimitX96!=0||!v2Fee[leg.root].configured)revert InvalidRoute();}
        else if(leg.venueVersion==3){generation=6;if(leg.generation!=0||leg.stable||leg.tickSpacing!=0)revert InvalidRoute();}
        else if(leg.venueVersion==6){generation=1;if(leg.generation!=1||leg.fee!=0||leg.tickSpacing!=0||leg.sqrtPriceLimitX96!=0)revert InvalidRoute();}
        else if(leg.venueVersion==7){generation=leg.generation;if(generation<2||generation>4||leg.stable||leg.fee!=0||leg.tickSpacing<=0)revert InvalidRoute();}
        else revert InvalidRoute();
        _pin(leg.root,trustedFactory[generation][leg.root]);
        if(IAeroV2Pool(leg.pool).token0()!=t0||IAeroV2Pool(leg.pool).token1()!=t1)revert InvalidRoute();
        if(leg.venueVersion==2){if(IAeroV2UniV2Factory(leg.root).getPair(t0,t1)!=leg.pool)revert UntrustedRoot();}
        else if(leg.venueVersion==3){if(IAeroV2UniV3Factory(leg.root).getPool(t0,t1,leg.fee)!=leg.pool)revert UntrustedRoot();}
        else {
            if(IAeroV2Pool(leg.pool).factory()!=leg.root)revert UntrustedRoot();
            if(leg.venueVersion==6){if(IAeroV2Pool(leg.pool).stable()!=leg.stable||IAeroV2ClassicFactory(leg.root).getPool(t0,t1,leg.stable)!=leg.pool)revert UntrustedRoot();}
            else if(IAeroV2Pool(leg.pool).tickSpacing()!=leg.tickSpacing||IAeroV2CLFactory(leg.root).getPool(t0,t1,leg.tickSpacing)!=leg.pool)revert UntrustedRoot();
        }
    }
    function _swap(AeroLeg memory leg,uint256 amount) private returns(uint256 output,uint24 legFee) {
        if(amount==0||amount>uint256(type(int256).max))revert InvalidRoute();
        uint256 beforeOut=IAeroV2Token(leg.tokenOut).balanceOf(address(this));
        uint256 beforeIn=IAeroV2Token(leg.tokenIn).balanceOf(address(this));
        bool zero=leg.tokenIn<leg.tokenOut;
        if(leg.venueVersion==6) {
            uint256 requested=IAeroV2Pool(leg.pool).getAmountOut(amount,leg.tokenIn);
            if(requested<leg.minAmountOut)revert InsufficientOutput();
            _transfer(leg.tokenIn,leg.pool,amount);
            IAeroV2Pool(leg.pool).swap(zero?0:requested,zero?requested:0,address(this),bytes(""));
        } else if(leg.venueVersion==2) {
            // Output from the pool's actual received input and reserves; no off-chain quoted amount.
            (uint256 r0,uint256 r1,)=IAeroV2Pool(leg.pool).getReserves();
            (uint256 reserveIn,uint256 reserveOut)=zero?(r0,r1):(r1,r0);
            _transfer(leg.tokenIn,leg.pool,amount);
            uint256 received=IAeroV2Token(leg.tokenIn).balanceOf(leg.pool)-reserveIn;
            legFee=v2Fee[leg.root].feePips;
            uint256 net=received*(1000000-legFee);
            uint256 requested=net*reserveOut/(reserveIn*1000000+net);
            if(requested<leg.minAmountOut)revert InsufficientOutput();
            IAeroV2Pool(leg.pool).swap(zero?0:requested,zero?requested:0,address(this),bytes(""));
        } else if(leg.venueVersion==8) {
            legFee=leg.fee;
            AeroV4PoolKey memory key=AeroV4PoolKey(zero?leg.tokenIn:leg.tokenOut,zero?leg.tokenOut:leg.tokenIn,leg.fee,leg.tickSpacing,address(0));
            if(lenderKind==3&&leg.root==lender)_v4Swap(leg.root,key,zero,amount,leg.sqrtPriceLimitX96);
            else {
                bytes memory callback=abi.encode(routeHash,key,zero,amount,leg.sqrtPriceLimitX96);
                expectedPool=leg.root;swapHash=keccak256(callback);swapOwed=0;phase=4;
                IAeroV4Manager(leg.root).unlock(callback);
                if(phase!=1||swapOwed!=amount)revert CallbackOnly();
                expectedPool=address(0);swapHash=0;
            }
        } else {
            legFee=IAeroV2Pool(leg.pool).fee();
            expectedPool=leg.pool;expectedInput=leg.tokenIn;expectedAmount=amount;expectedZeroForOne=zero;swapOwed=0;
            bytes memory callback=abi.encode(routeHash,leg.pool,leg.tokenIn,amount);swapHash=keccak256(callback);phase=2;
            (int256 a,int256 b)=IAeroV2CLPool(leg.pool).swap(address(this),zero,int256(amount),leg.sqrtPriceLimitX96,callback);
            if(phase!=1||swapOwed!=amount||(zero?a:b)!=int256(amount)||(zero?b:a)>=0)revert CallbackOnly();
            expectedPool=address(0);expectedInput=address(0);expectedAmount=0;swapHash=0;
        }
        if(IAeroV2Token(leg.tokenIn).balanceOf(address(this))+amount!=beforeIn)revert InvalidRoute();
        output=IAeroV2Token(leg.tokenOut).balanceOf(address(this))-beforeOut;
        if(output<leg.minAmountOut)revert InsufficientOutput();
    }
    /// Exact-input V4 swap inside an unlock: a partial fill (price limit hit) reverts.
    function _v4Swap(address manager,AeroV4PoolKey memory key,bool zeroForOne,uint256 amount,uint160 limit) private returns(uint256 out) {
        int256 delta=IAeroV4Manager(manager).swap(key,AeroV4SwapParams(zeroForOne,-int256(amount),limit),bytes(""));
        int128 a0=int128(delta>>128);int128 a1=int128(delta);
        (int128 paid,int128 received)=zeroForOne?(a0,a1):(a1,a0);
        if(int256(paid)!=-int256(amount)||received<=0)revert CallbackOnly();
        out=uint256(uint128(received));
        _v4Pay(manager,zeroForOne?key.currency0:key.currency1,amount);
        IAeroV4Manager(manager).take(zeroForOne?key.currency1:key.currency0,address(this),out);
    }
    function _v4Pay(address manager,address asset,uint256 amount) private {
        IAeroV4Manager(manager).sync(asset);_transfer(asset,manager,amount);IAeroV4Manager(manager).settle();
    }
    function uniswapV3SwapCallback(int256 a,int256 b,bytes calldata data) external {
        if(phase!=2||msg.sender!=expectedPool||keccak256(data)!=swapHash)revert CallbackOnly();
        if(expectedZeroForOne?(a<=0||b>=0):(b<=0||a>=0))revert CallbackOnly();
        uint256 owed=uint256(expectedZeroForOne?a:b);if(owed!=expectedAmount)revert CallbackOnly();
        phase=1;swapOwed=owed;_transfer(expectedInput,msg.sender,owed);
    }
    function _pin(address target,bytes32 codeHash) private view {if(codeHash==0||target.code.length==0||target.codehash!=codeHash)revert UntrustedRoot();}
    function _isClone(address target,address implementation) private view returns(bool) {
        bytes memory code=target.code;
        if(code.length!=45)return false;
        address embedded;assembly {embedded:=shr(96,mload(add(code,42)))}
        return embedded==implementation&&keccak256(code)==keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73",implementation,hex"5af43d82803e903d91602b57fd5bf3"));
    }
    function _transfer(address asset,address to,uint256 amount) private {
        (bool ok,bytes memory result)=asset.call(abi.encodeCall(IAeroV2Token.transfer,(to,amount)));if(!ok||(result.length!=0&&(result.length!=32||!abi.decode(result,(bool)))))revert TransferFailed();
    }
    function _approve(address asset,address to,uint256 amount) private {
        (bool ok,bytes memory result)=asset.call(abi.encodeCall(IAeroV2Token.approve,(to,amount)));if(!ok||(result.length!=0&&(result.length!=32||!abi.decode(result,(bool)))))revert TransferFailed();
    }
}
