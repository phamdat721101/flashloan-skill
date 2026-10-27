import {digest} from '../liquidity/state.js';
import type {PoolStateEnvelope} from '../liquidity/projection.js';
import {compilePolicy,type Profile} from '../evidence/economics.js';
import type {Asset,EvidenceRef,RunRequest} from '../evidence/contracts.js';
import type {CapturedMarket,EvidenceHost} from '../evidence/runtime.js';
export const h='a'.repeat(64),now=1000000000n,token0=`0x${'1'.repeat(40)}`,token1=`0x${'2'.repeat(40)}`;
export const asset:Asset={namespace:'eip155',networkId:'42161',assetId:token0,decimals:0};
export const ref=(kind:EvidenceRef['kind'],hash=h):EvidenceRef=>({kind,contentHash:hash,sourceId:'constructed-test',locator:'constructed-test',observedAtNs:now.toString(),expiresAtNs:(now+100000000000n).toString()});
export function pools():PoolStateEnvelope[]{return [0,1].map((i)=>({schemaVersion:'4.0',identity:{chain:'arbitrum',network:'42161',height:'1',blockHash:`0x${h}`},poolId:`arbitrum:42161:pool-${i}`,poolAddress:`0x${String(i+3).repeat(40)}`,adapterRevision:'fixture-v2',revisionHash:`0x${h}`,token0,token1,decimals0:0,decimals1:0,stateClass:'canonical',appliedOperations:[],state:{protocol:'uniswap-v2',reserve0:'100000',reserve1:i?'140000':'100000',feeNumerator:'997',feeDenominator:'1000'}}));}
export function fixture(){
 const profile:Profile={principalCapRaw:'1000',minimumPrincipalRaw:'100',minimumBranchRaw:'0',minProfitUsd:{numerator:'10',denominator:'1'},maxPriceImpactBps:1000,minDeploymentBps:0,minBranchWeightBps:0,maxHopsPerBranch:2,maxBranches:1,maxTotalSwaps:2,maxAttempts:100,deadlineMs:1000,maxStateAgeNs:'100000000000',maxDailyLossRaw:'1000'};
 const request:RunRequest={schemaVersion:'5.1',recordType:'run-request',runId:'test-run',mode:'research',networkId:'42161',assetLocators:[{namespace:asset.namespace,networkId:asset.networkId,assetId:token0},{namespace:asset.namespace,networkId:asset.networkId,assetId:token1}],borrowAsset:{namespace:asset.namespace,networkId:asset.networkId,assetId:token0},riskProfileRef:ref('configuration',digest(profile)),principalCapRaw:'1000',requestedMinProfitUsd:null,requestedPriceImpactBps:null,networkCostEvidenceRef:ref('configuration'),valuationEvidenceRef:ref('configuration'),watchDurationMs:0,caller:null,executor:null,executorMode:'fixture',rotationMode:'report-only',requestedMinDeploymentBps:0,requestedMinBranchWeightBps:0,requestedMinPrincipalUsd:null,requestedMinBranchUsd:null,inventoryMinLiquidityUsd:null};
 const market:CapturedMarket={identity:{namespace:'eip155',networkId:'42161',height:'1',stateHashOrDigest:`0x${h}`,finality:'node-confirmed'},pools:pools(),asset,lender:{capacityRaw:'1000',feeNumerator:'0',feeDenominator:'1',evidence:ref('configuration')},networkCost:{asset,amountRaw:{value:'1',reason:null},basis:'fee-estimate',includedInSwapOutput:false,evidence:ref('configuration')},valuation:{price:{numerator:'1',denominator:'1'},ref:ref('configuration')},observedAtNs:now.toString(),quantumRaw:'100'};
 const host:EvidenceHost={profile:async()=>({body:profile,ref:request.riskProfileRef!}),inventory:async()=>[],capture:async()=>market};
 const policy=compilePolicy(request,{body:profile,ref:request.riskProfileRef!},asset,market.valuation,now);
 return {request,market,profile,policy,host};
}
