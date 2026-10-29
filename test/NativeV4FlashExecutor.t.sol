// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {NativeV4FlashExecutor, NativePoolKey, NativeSwapParams} from "../contracts/NativeV4FlashExecutor.sol";
import {FlashCallbackCore} from "../contracts/core/FlashCallbackCore.sol";
import {MultiVenueArbitrageExecutor} from "../contracts/MultiVenueArbitrageExecutor.sol";
import {PortableMultiSplitFlashExecutor} from "../contracts/PortableMultiSplitFlashExecutor.sol";
import {TestMorphoLender, TestBalancerLender} from "./MultiVenueArbitrageExecutor.t.sol";
import {TestToken} from "./ImmutableArbitrageExecutor.t.sol";

interface NativeVm { function deal(address, uint256) external; function prank(address) external; }

contract TestWETH {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external { balanceOf[msg.sender] -= amount; (bool ok,) = msg.sender.call{value: amount}(""); require(ok, "eth"); }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) { allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true; }
}

contract Forcer { constructor(address payable target) payable { selfdestruct(target); } }

interface IUnlock { function unlockCallback(bytes calldata) external returns (bytes memory); function withdrawNative(uint256, address payable) external; }

/// Strict native-aware PoolManager model: per-currency caller deltas must net to zero; settle() credits msg.value only when the
/// synced currency is native (address(0)), matching v4-core's NonzeroNativeValue rule for a stale ERC20 sync.
contract NativeStrictManager {
    mapping(address => int256) public delta;
    address[] private touched;
    address public synced; uint256 private syncedBalance;
    bool private locked;
    mapping(bytes32 => uint256[2]) public rate; // token1 per token0 = num/den
    uint256 public forceDuringSwap; bool public reenterOnTake; bool public skipSync;
    function setRate(NativePoolKey calldata k, uint256 num, uint256 den) external { rate[keccak256(abi.encode(k))] = [num, den]; }
    function setForce(uint256 v) external { forceDuringSwap = v; }
    function setReenter(bool v) external { reenterOnTake = v; }
    function staleSync(address c) external { synced = c; syncedBalance = c == address(0) ? 0 : TestToken(c).balanceOf(address(this)); }
    function unlock(bytes calldata data) external returns (bytes memory r) {
        require(!locked, "locked"); locked = true;
        r = IUnlock(msg.sender).unlockCallback(data);
        for (uint256 i; i < touched.length; ++i) require(delta[touched[i]] == 0, "CurrencyNotSettled");
        delete touched; locked = false;
    }
    function swap(NativePoolKey calldata k, NativeSwapParams calldata p, bytes calldata) external returns (int256) {
        require(locked, "unlock"); uint256[2] memory r = rate[keccak256(abi.encode(k))]; require(r[1] != 0, "pool");
        uint256 amountIn = uint256(-p.amountSpecified);
        uint256 out = p.zeroForOne ? amountIn * r[0] / r[1] : amountIn * r[1] / r[0];
        (int128 a0, int128 a1) = p.zeroForOne ? (-int128(int256(amountIn)), int128(int256(out))) : (int128(int256(out)), -int128(int256(amountIn)));
        _touch(k.currency0, a0); _touch(k.currency1, a1);
        if (forceDuringSwap != 0) new Forcer{value: forceDuringSwap}(payable(msg.sender));
        return (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }
    function sync(address c) external { synced = c; syncedBalance = c == address(0) ? 0 : TestToken(c).balanceOf(address(this)); }
    function settle() external payable returns (uint256 paid) {
        if (synced == address(0)) { paid = msg.value; _touch(address(0), int128(int256(paid))); }
        else { require(msg.value == 0, "NonzeroNativeValue"); paid = TestToken(synced).balanceOf(address(this)) - syncedBalance; _touch(synced, int128(int256(paid))); }
        synced = address(0); syncedBalance = 0;
    }
    function take(address c, address to, uint256 amount) external {
        _touch(c, -int128(int256(amount)));
        if (c == address(0)) {
            if (reenterOnTake) IUnlock(to).withdrawNative(1, payable(address(this)));
            (bool ok,) = to.call{value: amount}(""); require(ok, "take");
        } else TestToken(c).transfer(to, amount);
    }
    function _touch(address c, int128 d) private { if (delta[c] == 0) touched.push(c); delta[c] += d; }
    receive() external payable {}
}

contract NativeV4FlashExecutorTest {
    NativeVm private constant vm = NativeVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    receive() external payable {}

    struct Fx { NativeV4FlashExecutor e; TestWETH weth; TestToken token; NativeStrictManager m; address lender; NativePoolKey buy; NativePoolKey sell; }

    function fixture(uint8 kind) private returns (Fx memory f) {
        f.weth = new TestWETH(); f.token = new TestToken(); f.m = new NativeStrictManager();
        f.e = new NativeV4FlashExecutor(address(f.weth), address(f.weth).codehash);
        f.e.configureManager(address(f.m), address(f.m).codehash, true);
        f.lender = kind == 1 ? address(new TestMorphoLender()) : address(new TestBalancerLender());
        f.e.configureLender(kind, f.lender, f.lender.codehash, true);
        vm.deal(address(this), 2000 ether);
        f.weth.deposit{value: 1000 ether}(); f.weth.transfer(f.lender, 500 ether);
        vm.deal(address(f.m), 1000 ether); f.token.mint(address(f.m), 1e30);
        f.buy = NativePoolKey(address(0), address(f.token), 3000, 60, address(0));
        f.sell = NativePoolKey(address(0), address(f.token), 500, 10, address(0));
        f.m.setRate(f.buy, 2, 1);          // 1 ETH -> 2 TOKEN
        f.m.setRate(f.sell, 1923, 1000);   // 1.923 TOKEN -> 1 ETH
    }
    function cycle(Fx memory f, uint256 amount) private pure returns (NativeV4FlashExecutor.NativeAction[] memory a) {
        NativePoolKey memory none;
        a = new NativeV4FlashExecutor.NativeAction[](4);
        a[0] = NativeV4FlashExecutor.NativeAction(1, address(f.weth), address(0), amount, address(0), none, 0, "");
        a[1] = NativeV4FlashExecutor.NativeAction(0, address(0), address(f.token), 1, address(f.m), f.buy, 0, "");
        a[2] = NativeV4FlashExecutor.NativeAction(0, address(f.token), address(0), 1, address(f.m), f.sell, 0, "");
        a[3] = NativeV4FlashExecutor.NativeAction(2, address(0), address(f.weth), 1, address(0), none, 0, "");
    }
    function route(Fx memory f, uint8 kind, uint256[] memory allocations, uint256 minSurplus) private view returns (NativeV4FlashExecutor.NativeRoute memory r) {
        NativeV4FlashExecutor.NativeBranch[] memory b = new NativeV4FlashExecutor.NativeBranch[](allocations.length);
        uint256 total;
        for (uint256 i; i < allocations.length; ++i) { b[i] = NativeV4FlashExecutor.NativeBranch(allocations[i], cycle(f, allocations[i])); total += allocations[i]; }
        r = NativeV4FlashExecutor.NativeRoute(kind, f.lender, address(f.weth), total, b, minSurplus, block.timestamp + 1);
    }
    function one(uint256 v) private pure returns (uint256[] memory a) { a = new uint256[](1); a[0] = v; }

    function test_nativeCycleUnwrapSwapWrapRepays() external {
        Fx memory f = fixture(1);
        f.e.executeNativeArbitrage(route(f, 1, one(100 ether), 4 ether));
        // 100 ETH -> 200 TOKEN -> 104.0041... ETH, all rewrapped; lender fully repaid, surplus retained as WETH custody.
        require(f.weth.balanceOf(f.lender) == 500 ether, "repaid");
        require(f.weth.balanceOf(address(f.e)) == uint256(200 ether) * 1000 / 1923 - 100 ether, "surplus custody");
        require(address(f.e).balance == 0, "no native left");
    }
    function test_balancerSplitBranchesShareManagerAndPayFee() external {
        Fx memory f = fixture(2);
        uint256[] memory alloc = new uint256[](2); alloc[0] = 60 ether; alloc[1] = 40 ether;
        f.e.executeNativeArbitrage(route(f, 2, alloc, 3 ether));
        require(f.weth.balanceOf(f.lender) == 500 ether + 3, "fee");
    }
    function test_priorErc20SyncResetBeforeNativeSettle() external {
        Fx memory f = fixture(1);
        f.m.staleSync(address(f.token)); // a stale ERC20 sync left in the manager
        try f.m.settle{value: 1}() { revert("model must reject native value under ERC20 sync"); } catch {}
        f.m.staleSync(address(f.token));
        f.e.executeNativeArbitrage(route(f, 1, one(100 ether), 4 ether)); // executor resets with sync(address(0)) first
    }
    function test_forcedEthDuringCallbackNotCountedAsProfit() external {
        Fx memory f = fixture(1);
        new Forcer{value: 5 ether}(payable(address(f.e))); // before execution: excluded by the native opening baseline
        f.m.setForce(7 ether);                                // during every swap callback: unattributable
        uint256 wethBefore = f.weth.balanceOf(address(f.e));
        f.e.executeNativeArbitrage(route(f, 1, one(100 ether), 4 ether));
        require(f.weth.balanceOf(address(f.e)) - wethBefore == uint256(200 ether) * 1000 / 1923 - 100 ether, "forced ETH never becomes WETH profit");
        require(address(f.e).balance == 5 ether + 14 ether, "forced ETH stays as reported custody");
        // A route whose debt needs more than the attributable native cannot borrow donations to cover it.
        Fx memory g = fixture(1);
        new Forcer{value: 50 ether}(payable(address(g.e)));
        NativeV4FlashExecutor.NativeRoute memory r = route(g, 1, one(100 ether), 4 ether);
        g.m.setRate(g.sell, 4, 1); // 200 TOKEN -> 50 ETH: the wrap threads only the 50 attributable ETH, so the 50 ETH deficit is never filled by the donation
        try g.e.executeNativeArbitrage(r) { revert("deficit funded by donation"); } catch {}
    }
    function test_receiveReentrancyReverts() external {
        Fx memory f = fixture(1);
        (bool ok,) = address(f.e).call{value: 1}(""); require(!ok, "idle receive");
        f.m.setReenter(true);
        try f.e.executeNativeArbitrage(route(f, 1, one(100 ether), 4 ether)) { revert("reentrant withdraw"); } catch {}
        require(f.weth.balanceOf(f.lender) == 500 ether, "atomic");
    }
    function test_branchAllocationsMustSumToPrincipal() external {
        Fx memory f = fixture(1);
        NativeV4FlashExecutor.NativeRoute memory r = route(f, 1, one(100 ether), 4 ether);
        r.principalRaw = 101 ether;
        try f.e.executeNativeArbitrage(r) { revert("allocation"); } catch {}
        r = route(f, 1, one(100 ether), 4 ether); r.branches[0].actions[3].tokenOut = address(f.token);
        try f.e.executeNativeArbitrage(r) { revert("terminal asset"); } catch {}
        r = route(f, 1, one(100 ether), 4 ether); r.branches[0].actions[1].key.hooks = address(0xc0);
        try f.e.executeNativeArbitrage(r) { revert("hooks"); } catch {}
        r = route(f, 1, one(100 ether), 4 ether); r.branches[0].actions[0].manager = address(f.m);
        try f.e.executeNativeArbitrage(r) { revert("wrap sentinel"); } catch {}
        r = route(f, 1, one(100 ether), 1000 ether);
        try f.e.executeNativeArbitrage(r) { revert("min surplus"); } catch {}
    }
    function test_unauthenticatedCallbackReverts() external {
        Fx memory f = fixture(1);
        try f.e.unlockCallback("") { revert("unlock"); } catch {}
        try f.e.onMorphoFlashLoan(1, "") { revert("morpho"); } catch {}
        address[] memory t = new address[](1); uint256[] memory a = new uint256[](1);
        try f.e.receiveFlashLoan(t, a, a, "") { revert("balancer"); } catch {}
        vm.prank(address(0xbad));
        try f.e.executeNativeArbitrage(route(f, 1, one(100 ether), 4 ether)) { revert("owner"); } catch {}
    }
}

/// Review A1: the same negative callback cases against all three executor families (legacy copies and the new core).
contract CallbackAuthParity {
    function _assertRejects(address target) private {
        (bool a,) = target.call(abi.encodeWithSignature("onMorphoFlashLoan(uint256,bytes)", 1, bytes("")));
        address[] memory t = new address[](1); uint256[] memory n = new uint256[](1);
        (bool b,) = target.call(abi.encodeWithSignature("receiveFlashLoan(address[],uint256[],uint256[],bytes)", t, n, n, bytes("")));
        (bool c,) = target.call(abi.encodeWithSignature("unlockCallback(bytes)", bytes("")));
        require(!a && !b && !c, "unauthenticated callback accepted");
    }
    function test_multiVenueRejectsUnauthenticatedCallbacks() external { _assertRejects(address(new MultiVenueArbitrageExecutor())); }
    function test_portableSplitRejectsUnauthenticatedCallbacks() external { _assertRejects(address(new PortableMultiSplitFlashExecutor())); }
    function test_nativeV4RejectsUnauthenticatedCallbacks() external { TestWETH w = new TestWETH(); _assertRejects(address(new NativeV4FlashExecutor(address(w), address(w).codehash))); }
}
