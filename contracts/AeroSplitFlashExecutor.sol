// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IAeroToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function approve(address,uint256) external returns (bool);
}
interface IAeroMorpho { function flashLoan(address,uint256,bytes calldata) external; }
interface IAeroBalancer { function flashLoan(address,address[] calldata,uint256[] calldata,bytes calldata) external; }
interface IAeroPool {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    function tickSpacing() external view returns (int24);
    function getAmountOut(uint256,address) external view returns (uint256);
    function swap(uint256,uint256,address,bytes calldata) external;
}
interface IAeroClassicFactory { function getPool(address,address,bool) external view returns (address); }
interface IAeroCLFactory { function getPool(address,address,int24) external view returns (address); }
interface IAeroV2Factory { function getPair(address,address) external view returns (address); }
interface IAeroV3Factory { function getPool(address,address,uint24) external view returns (address); }
interface IAeroCLPool { function swap(address,bool,int256,uint160,bytes calldata) external returns (int256,int256); }

/// @notice New artifact: existing portable executors and their selectors are unchanged.
/// All roots/pools are opt-in; only the immutable owner can execute or withdraw.
contract AeroSplitFlashExecutor {
    error Unauthorized(); error InvalidRoute(); error UntrustedRoot(); error CallbackOnly();
    error InsufficientOutput(); error Unprofitable(); error TransferFailed(); error Busy();
    struct AeroLeg {
        uint8 venueVersion; address root; address pool; address tokenIn; address tokenOut;
        uint256 minAmountOut; uint256 quotedAmountOut; uint24 fee;
        uint160 sqrtPriceLimitX96; int24 tickSpacing; bool stable; uint8 generation;
    }
    struct AeroBranch { uint256 amountIn; AeroLeg[] legs; }
    struct AeroSplitRoute {
        uint8 kind; address lender; address flashAsset; uint256 flashAmount;
        AeroBranch[] branches; uint256 minProfit; uint256 deadline;
    }
    struct PoolPin { bytes32 runtimeHash; address implementation; bytes32 implementationHash; }
    address public immutable owner;
    mapping(uint8 => mapping(address => bytes32)) public trustedFactory;
    mapping(uint8 => mapping(address => bytes32)) public trustedLender;
    mapping(address => PoolPin) public trustedPool;
    mapping(address => uint256) public maxLenderFee;
    // Idle -> Loan -> Swap -> Loan -> Settled -> Idle. A callback can advance
    // its expected phase only once; external configuration requires Idle.
    uint8 private phase;
    address private lender;
    uint8 private lenderKind;
    bytes32 private routeHash;
    uint256 private opening;
    bool private loanCompleted;
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
    constructor() { owner=msg.sender; }
    modifier onlyOwner() { if(msg.sender!=owner)revert Unauthorized(); _; }
    modifier idle() { if(phase!=0)revert Busy(); _; }
    function configureFactory(uint8 generation,address root,bytes32 codeHash) external onlyOwner idle {
        if(generation>6||root==address(0)||(codeHash!=0&&(root.code.length==0||root.codehash!=codeHash)))revert UntrustedRoot();
        trustedFactory[generation][root]=codeHash;emit RootConfigured(generation,root,codeHash);
    }
    // generation 0 is unused; external V2=5, external V3=6 for factory pins.
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
        if(kind<1||kind>2||root==address(0)||(codeHash!=0&&(root.code.length==0||root.codehash!=codeHash))||(kind==1&&feeLimit!=0))revert UntrustedRoot();
        trustedLender[kind][root]=codeHash;maxLenderFee[root]=feeLimit;
    }
    function withdraw(address asset,uint256 amount,address recipient) external onlyOwner idle { if(recipient==address(0))revert InvalidRoute();_transfer(asset,recipient,amount); }
    function executeAeroSplitArbitrage(AeroSplitRoute calldata route) external onlyOwner idle returns(uint256 profit) {
        if(block.timestamp>route.deadline||route.flashAmount==0||route.flashAmount>uint256(type(int256).max)||route.minProfit==0||route.branches.length==0||route.branches.length>8||route.kind<1||route.kind>2)revert InvalidRoute();
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
        bytes memory data=abi.encode(route);routeHash=keccak256(data);lender=route.lender;lenderKind=route.kind;
        opening=IAeroToken(route.flashAsset).balanceOf(address(this));loanCompleted=false;phase=1;
        if(route.kind==1)IAeroMorpho(route.lender).flashLoan(route.flashAsset,route.flashAmount,data);
        else {address[] memory assets=new address[](1);assets[0]=route.flashAsset;uint256[] memory amounts=new uint256[](1);amounts[0]=route.flashAmount;IAeroBalancer(route.lender).flashLoan(address(this),assets,amounts,data);}
        if(!loanCompleted||phase!=3||IAeroToken(route.flashAsset).balanceOf(address(this))<opening+route.minProfit)revert Unprofitable();
        profit=IAeroToken(route.flashAsset).balanceOf(address(this))-opening;
        if(route.kind==1)_approve(route.flashAsset,route.lender,0);
        phase=0;lender=address(0);routeHash=0;opening=0;loanCompleted=false;
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
    function _execute(AeroSplitRoute memory route,uint256 fee) private {
        if(IAeroToken(route.flashAsset).balanceOf(address(this))!=opening+route.flashAmount)revert InvalidRoute();
        for(uint256 i;i<route.branches.length;i++) {
            uint256 amount=route.branches[i].amountIn;
            for(uint256 j;j<route.branches[i].legs.length;j++){uint256 next=_swap(route.branches[i].legs[j],amount);emit AeroLegExecuted(routeHash,i,j,route.branches[i].legs[j].pool,amount,next);amount=next;}
        }
        uint256 closing=IAeroToken(route.flashAsset).balanceOf(address(this));
        if(closing<opening+route.flashAmount+fee+route.minProfit)revert Unprofitable();
        emit AeroArbitrageExecuted(routeHash,route.flashAsset,route.flashAmount,fee,closing-opening-route.flashAmount-fee,route.branches.length);
    }
    function _validate(AeroLeg memory leg) private view {
        if(leg.tokenIn==address(0)||leg.tokenOut==address(0)||leg.root==address(0))revert InvalidRoute();
        PoolPin memory pin=trustedPool[leg.pool];_pin(leg.pool,pin.runtimeHash);_pin(pin.implementation,pin.implementationHash);
        uint8 generation;
        if(leg.venueVersion==2){generation=5;if(leg.generation!=0||leg.stable||leg.fee!=0||leg.tickSpacing!=0||leg.sqrtPriceLimitX96!=0||leg.quotedAmountOut<leg.minAmountOut)revert InvalidRoute();}
        else if(leg.venueVersion==3){generation=6;if(leg.generation!=0||leg.stable||leg.tickSpacing!=0||leg.quotedAmountOut!=0)revert InvalidRoute();}
        else if(leg.venueVersion==6){generation=1;if(leg.generation!=1||leg.fee!=0||leg.tickSpacing!=0||leg.sqrtPriceLimitX96!=0||leg.quotedAmountOut!=0)revert InvalidRoute();}
        else if(leg.venueVersion==7){generation=leg.generation;if(generation<2||generation>4||leg.stable||leg.fee!=0||leg.tickSpacing<=0||leg.quotedAmountOut!=0)revert InvalidRoute();}
        else revert InvalidRoute();
        _pin(leg.root,trustedFactory[generation][leg.root]);
        address t0=IAeroPool(leg.pool).token0();address t1=IAeroPool(leg.pool).token1();
        if(t0>=t1||!((leg.tokenIn==t0&&leg.tokenOut==t1)||(leg.tokenIn==t1&&leg.tokenOut==t0)))revert InvalidRoute();
        if(leg.venueVersion==2){if(IAeroV2Factory(leg.root).getPair(t0,t1)!=leg.pool)revert UntrustedRoot();}
        else if(leg.venueVersion==3){if(IAeroV3Factory(leg.root).getPool(t0,t1,leg.fee)!=leg.pool)revert UntrustedRoot();}
        else {
            if(IAeroPool(leg.pool).factory()!=leg.root)revert UntrustedRoot();
            if(leg.venueVersion==6){if(IAeroPool(leg.pool).stable()!=leg.stable||IAeroClassicFactory(leg.root).getPool(t0,t1,leg.stable)!=leg.pool)revert UntrustedRoot();}
            else if(IAeroPool(leg.pool).tickSpacing()!=leg.tickSpacing||IAeroCLFactory(leg.root).getPool(t0,t1,leg.tickSpacing)!=leg.pool)revert UntrustedRoot();
        }
    }
    function _swap(AeroLeg memory leg,uint256 amount) private returns(uint256 output) {
        _validate(leg);if(amount==0||amount>uint256(type(int256).max))revert InvalidRoute();
        uint256 beforeOut=IAeroToken(leg.tokenOut).balanceOf(address(this));
        uint256 beforeIn=IAeroToken(leg.tokenIn).balanceOf(address(this));
        if(leg.venueVersion==2||leg.venueVersion==6) {
            uint256 requested=leg.venueVersion==6?IAeroPool(leg.pool).getAmountOut(amount,leg.tokenIn):leg.quotedAmountOut;
            if(requested<leg.minAmountOut)revert InsufficientOutput();
            _transfer(leg.tokenIn,leg.pool,amount);
            bool zero=leg.tokenIn<leg.tokenOut;
            IAeroPool(leg.pool).swap(zero?0:requested,zero?requested:0,address(this),bytes(""));
        } else {
            expectedPool=leg.pool;expectedInput=leg.tokenIn;expectedAmount=amount;expectedZeroForOne=leg.tokenIn<leg.tokenOut;swapOwed=0;
            bytes memory callback=abi.encode(routeHash,leg.pool,leg.tokenIn,amount);swapHash=keccak256(callback);phase=2;
            (int256 a,int256 b)=IAeroCLPool(leg.pool).swap(address(this),expectedZeroForOne,int256(amount),leg.sqrtPriceLimitX96,callback);
            if(phase!=1||swapOwed!=amount||(expectedZeroForOne?a:b)!=int256(amount)||(expectedZeroForOne?b:a)>=0)revert CallbackOnly();
            expectedPool=address(0);expectedInput=address(0);expectedAmount=0;swapHash=0;
        }
        if(IAeroToken(leg.tokenIn).balanceOf(address(this))+amount!=beforeIn)revert InvalidRoute();
        output=IAeroToken(leg.tokenOut).balanceOf(address(this))-beforeOut;
        if(output<leg.minAmountOut)revert InsufficientOutput();
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
        (bool ok,bytes memory result)=asset.call(abi.encodeCall(IAeroToken.transfer,(to,amount)));if(!ok||(result.length!=0&&(result.length!=32||!abi.decode(result,(bool)))))revert TransferFailed();
    }
    function _approve(address asset,address to,uint256 amount) private {
        (bool ok,bytes memory result)=asset.call(abi.encodeCall(IAeroToken.approve,(to,amount)));if(!ok||(result.length!=0&&(result.length!=32||!abi.decode(result,(bool)))))revert TransferFailed();
    }
}
