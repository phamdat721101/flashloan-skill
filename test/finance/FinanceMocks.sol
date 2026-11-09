// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

/// Local fixtures for Finance tests only. Never deployed to a public network; never production evidence.
contract FinMockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public minter;
    constructor() { minter = msg.sender; }
    function setMinter(address m) external { require(msg.sender == minter, "minter"); minter = m; }
    function mint(address to, uint256 amount) external { require(msg.sender == minter, "minter"); balanceOf[to] += amount; }
    function burn(address from, uint256 amount) external { require(msg.sender == minter, "minter"); balanceOf[from] -= amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}

/// Aave-V3-shaped pool with two reserves (id 0 = debt asset, id 1 = collateral asset), 1:1 prices, 80% LT.
contract FinMockAavePool {
    FinMockToken public immutable debtAsset; FinMockToken public immutable collateralAsset;
    FinMockToken public immutable aDebt; FinMockToken public immutable aCollateral; FinMockToken public immutable vDebt; FinMockToken public immutable vCollateral;
    uint256 public constant LT_BPS = 8000;
    constructor(FinMockToken debt, FinMockToken coll) {
        debtAsset = debt; collateralAsset = coll;
        aDebt = new FinMockToken(); aCollateral = new FinMockToken(); vDebt = new FinMockToken(); vCollateral = new FinMockToken();
    }
    function _a(address asset) private view returns (FinMockToken) { return asset == address(debtAsset) ? aDebt : asset == address(collateralAsset) ? aCollateral : FinMockToken(address(0)); }
    function _v(address asset) private view returns (FinMockToken) { return asset == address(debtAsset) ? vDebt : asset == address(collateralAsset) ? vCollateral : FinMockToken(address(0)); }
    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(address(_a(asset)) != address(0), "reserve");
        FinMockToken(asset).transferFrom(msg.sender, address(this), amount); _a(asset).mint(onBehalfOf, amount);
    }
    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        _a(asset).burn(msg.sender, amount); require(_healthy(msg.sender), "hf"); FinMockToken(asset).transfer(to, amount); return amount;
    }
    function borrow(address asset, uint256 amount, uint256 mode, uint16, address onBehalfOf) external {
        require(mode == 2 && onBehalfOf == msg.sender, "mode"); _v(asset).mint(onBehalfOf, amount); require(_healthy(onBehalfOf), "hf"); FinMockToken(asset).transfer(msg.sender, amount);
    }
    function repay(address asset, uint256 amount, uint256 mode, address onBehalfOf) external returns (uint256) {
        require(mode == 2, "mode"); uint256 owed = _v(asset).balanceOf(onBehalfOf); uint256 paid = amount > owed ? owed : amount;
        FinMockToken(asset).transferFrom(msg.sender, address(this), paid); _v(asset).burn(onBehalfOf, paid); return paid;
    }
    function _collateral(address u) private view returns (uint256) { return aCollateral.balanceOf(u); }
    function _debt(address u) private view returns (uint256) { return vDebt.balanceOf(u) + vCollateral.balanceOf(u); }
    function _healthy(address u) private view returns (bool) { return _debt(u) == 0 || _collateral(u) * LT_BPS / 10_000 >= _debt(u); }
    function getUserAccountData(address u) external view returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        uint256 c = _collateral(u); uint256 d = _debt(u);
        uint256 hf = d == 0 ? type(uint256).max : c * LT_BPS * 1e18 / 10_000 / d;
        uint256 avail = c * 7500 / 10_000 > d ? c * 7500 / 10_000 - d : 0;
        return (c, d, avail, LT_BPS, 7500, hf);
    }
    function getUserConfiguration(address u) external view returns (uint256) { return aCollateral.balanceOf(u) > 0 ? (1 << 3) : 0; } // reserve id 1 used as collateral
    function getUserEMode(address) external pure returns (uint256) { return 0; }
}

interface IFinMorphoCallback { function onMorphoFlashLoan(uint256 assets, bytes calldata data) external; }
/// Morpho-shaped zero-fee flash lender: transfers, calls back, pulls the principal back.
contract FinMockMorphoFlash {
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        FinMockToken(token).transfer(msg.sender, assets);
        IFinMorphoCallback(msg.sender).onMorphoFlashLoan(assets, data);
        FinMockToken(token).transferFrom(msg.sender, address(this), assets);
    }
}

/// Exact-input swap at a fixed rate (out = in * rateBps / 10000) funded from its own inventory.
contract FinMockSwapAdapter {
    uint256 public rateBps = 10_000;
    function setRate(uint256 r) external { rateBps = r; }
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient) external returns (uint256 out) {
        FinMockToken(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        out = amountIn * rateBps / 10_000; require(out >= minOut, "minOut");
        FinMockToken(tokenOut).transfer(recipient, out);
    }
}
