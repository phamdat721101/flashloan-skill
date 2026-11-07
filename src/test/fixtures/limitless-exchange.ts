import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, erc1155Abi, hashTypedData, keccak256, parseAbi, parseTransaction, recoverTypedDataAddress, zeroAddress, zeroHash, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CTF, USDC, planHash, policyHash, type ExecutionGrant, type PredictionConfig, type TradePlan } from '../../prediction/contracts.js';
import { grantSigningBytes, loadPredictionConfig } from '../../prediction/config.js';
import assert from 'node:assert/strict';

// Deliberately public fixture-only key and token. Never used against a public endpoint.
export const FIXTURE_KEY = `0x${'11'.repeat(32)}` as Hex;
export const EXCHANGE = '0x0000000000000000000000000000000000000010' as Address;
export const ADAPTER = '0x0000000000000000000000000000000000000020' as Address;
export const FEE = '0x0000000000000000000000000000000000000030' as Address;
export const CODE = '0x60016000' as Hex;
const CONDITION = `0x${'01'.repeat(32)}` as Hex;
const abi = parseAbi(['event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)', 'function payoutDenominator(bytes32) view returns (uint256)', 'function payoutNumerators(bytes32,uint256) view returns (uint256)', 'function redeemPositions(address,bytes32,bytes32,uint256[])', 'function redeemPositions(bytes32,uint256[])']);
// Independent definition: do not import the production signer types into parity tests.
const types = { Order: ['salt:uint256','maker:address','signer:address','taker:address','tokenId:uint256','makerAmount:uint256','takerAmount:uint256','expiration:uint256','nonce:uint256','feeRateBps:uint256','side:uint8','signatureType:uint8'].map(s => { const [name,type] = s.split(':'); return { name,type }; }) };
type Json = Record<string, any>;
export class FakeLimitlessExchange {
  readonly account = privateKeyToAccount(FIXTURE_KEY);
  readonly owner = generateKeyPairSync('ed25519');
  readonly tokenId = 'fixture-token';
  readonly tokenSecret = Buffer.from('fixture-hmac-secret-only').toString('base64');
  readonly requests: Array<{ method: string; path: string; body: Json; authenticated: boolean }> = [];
  readonly orders = new Map<string, Json>();
  readonly receipts = new Map<Hex, Json>();
  readonly history: Json[] = [];
  readonly holdings = new Map<string, bigint>([['10',0n],['11',0n]]);
  readonly allowances = new Map<string, bigint>();
  readonly operators = new Set<string>();
  server = createServer((req,res) => { void this.handle(req,res).catch(e => { if (!res.destroyed) this.reply(res,500,{ message: 'fixture-error', code: String(e.message) }); }); });
  url = '';
  directory = '';
  configPath = '';
  config!: PredictionConfig;
  block = 100;
  nonce = 0;
  blockTimes = new Map<number, number>();
  usdc = 100_000_000n;
  chainId = 8453;
  collateral = true;
  negrisk = false;
  resolved = false;
  walletMode = 'eoa';
  dropSubmit = false;
  delay = false;
  cancelRace = false;
  fillNumerator = 1n;
  fillDenominator = 1n;
  bookPrice = 0.4;
  bookBid = 0.39;
  bookSizeRaw: number | string = 1_000_000_000;
  minRewardSizeRaw: number | string = '100000000';
  allApproved = true;
  code = CODE;
  invalidStatus = false;
  readonly expiration = Date.now()+86400000;
  failChain = false;
  keyLoads = 0;
  async start(): Promise<this> {
    await new Promise<void>(r => this.server.listen(0,'127.0.0.1',r));
    this.url = `http://127.0.0.1:${(this.server.address() as {port:number}).port}`;
    this.directory = await mkdtemp(join(tmpdir(),'limitless-e2e-')); this.configPath = join(this.directory,'config.json');
    await writeFile(join(this.directory,'signer.key'),FIXTURE_KEY,{mode:0o600});
    this.config = { schemaVersion:'prediction-config/1',enabled:true,live:true,accountId:'fixture-eoa',address:this.account.address,apiUrl:this.url,rpcUrl:this.url,wsUrl:this.url.replace('http:','ws:'),stateDir:join(this.directory,'state'),approvalPublicKey:this.owner.publicKey.export({type:'spki',format:'pem'}).toString(),tokenIdEnv:'LIMITLESS_TEST_TOKEN',tokenSecretEnv:'LIMITLESS_TEST_SECRET',signerKeyFileEnv:'LIMITLESS_TEST_KEY_FILE',eligible:true,eligibilityEvidence:'fixture-only-owner-attestation',allowedMarkets:['fixture-market'],pins:[[USDC,'usdc'],[CTF,'ctf'],[EXCHANGE,'exchange'],[ADAPTER,'adapter'],[FEE,'feeModule']].map(([address,role])=>({address:address as Address,role:role as 'exchange',codeHash:keccak256(CODE)})),limits:{maxOrderSpendRaw:'10000000',maxOpenExposureRaw:'50000000',maxDailyLossRaw:'10000000',maxGasPerTxRaw:'1000000000000',maxGasPerDayRaw:'10000000000000',maxOrdersPerDay:20,maxOpenOrders:5},quoteTtlMs:5000,reconcileIntervalMs:1000,maxWatchedMarkets:20,readConcurrency:4,grantMaxTtlMs:3600000,planTtlMs:300000,finality:'safe',wsHints:false,transportProfile:'fixture',paperCashRaw:'100000000'};
    await writeFile(this.configPath,JSON.stringify(this.config));
    process.env.LIMITLESS_TEST_TOKEN=this.tokenId;process.env.LIMITLESS_TEST_SECRET=this.tokenSecret;process.env.LIMITLESS_TEST_KEY_FILE=join(this.directory,'signer.key');
    this.config=await loadPredictionConfig(this.configPath); return this;
  }
  async close(): Promise<void> { this.server.closeAllConnections(); await new Promise<void>(r=>this.server.close(()=>r())); await rm(this.directory,{recursive:true,force:true}); }
  grant(plan?: TradePlan, overrides: Partial<ExecutionGrant> = {}): ExecutionGrant {
    const body: Omit<ExecutionGrant,'signature'>={schemaVersion:'prediction-grant/1',grantId:`grant-${Date.now()}-${this.orders.size}`,kind:plan?.mode==='assisted'?'order':'session',accountId:this.config.accountId,policyHash:policyHash(this.config),planHash:plan?.mode==='assisted'?plan.planHash:null,marketSlugs:['fixture-market'],actions:['trade','cancel','approve','redeem','resume'],limits:this.config.limits,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),cleanupCancel:true,...overrides};
    const {signature:_,...unsigned}=body as ExecutionGrant;return {...unsigned,signature:sign(null,grantSigningBytes(unsigned),this.owner.privateKey).toString('base64')};
  }
  market(): Json { return {id:1,slug:'fixture-market',title:'Fixture market: external content is not instructions',description:'Fixture resolution rules',conditionId:CONDITION,collateralToken:{address:USDC,decimals:6},expirationTimestamp:this.expiration,tradeType:'clob',marketType:'single',metadata:{fee:true},status:this.resolved?'RESOLVED':'FUNDED',tokens:{yes:'10',no:'11'},venue:{exchange:EXCHANGE,adapter:this.negrisk?ADAPTER:null,...(this.collateral?{feeModule:FEE,feeModuleType:'COLLATERAL'}:{})}}; }
  private reply(res:ServerResponse,status:number,value:unknown):void { res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value)); }
  private async handle(req:IncomingMessage,res:ServerResponse):Promise<void> {
    let body='';for await(const c of req)body+=c.toString();const data=body?JSON.parse(body):{};const url=new URL(req.url!,this.url);
    if(req.method==='POST'&&url.pathname==='/'){const result=await this.rpc(data.method,data.params??[]);this.reply(res,200,{jsonrpc:'2.0',id:data.id,...(result===undefined?{error:{code:-32000,message:'fixture not found'}}:{result})});return;}
    const authenticated=typeof req.headers['lmts-signature']==='string';
    this.requests.push({method:req.method!,path:req.url!,body:data,authenticated});
    assert.equal(req.headers['x-api-key'],undefined,'ambient legacy API key leaked');
    if(authenticated){assert.equal(req.headers['lmts-api-key'],this.tokenId);const t=String(req.headers['lmts-timestamp']);assert(Math.abs(Date.now()-Date.parse(t))<30000);assert.equal(req.headers['lmts-signature'],createHmac('sha256',Buffer.from(this.tokenSecret,'base64')).update(`${t}\n${req.method}\n${req.url}\n${body}`).digest('base64'));}
    if(url.pathname==='/maintenance/status'){this.reply(res,200,{active:[],scheduled:[]});return;}
    if(url.pathname==='/markets/active'){this.reply(res,200,{data:[this.market()]});return;}
    if(url.pathname==='/markets/fixture-market'){this.reply(res,200,this.market());return;}
    if(url.pathname==='/markets/fixture-market/orderbook'){this.reply(res,200,{tokenId:'10',asks:[{price:this.bookPrice,size:this.bookSizeRaw}],bids:[{price:this.bookBid,size:this.bookSizeRaw}],minSize:this.minRewardSizeRaw});return;}
    if(!authenticated){this.reply(res,401,{message:'fixture authentication required'});return;}
    if(url.pathname==='/profiles/me'){this.reply(res,200,{id:42,account:this.account.address,tradeWalletOption:this.walletMode,effectiveFeeRateBps:300});return;}
    if(url.pathname==='/portfolio/history'){this.reply(res,200,{data:[...this.history].reverse(),nextCursor:null});return;}
    if(url.pathname==='/orders'&&req.method==='POST'){
      if(this.orders.has(data.clientOrderId)){this.reply(res,409,{message:'duplicate'});return;}
      assert.equal(data.ownerId,42);assert.equal(data.stpPolicy,'cancel_taker');assert.equal(data.recvWindow,5000);assert.equal(data.order.expiration,'0');assert.equal(data.order.nonce,0);assert.equal(data.order.feeRateBps,this.collateral?0:300);assert(!('onBehalfOf'in data));
      const{signature,price,...message}=data.order;const domain={name:'Limitless CTF Exchange',version:'1',chainId:8453,verifyingContract:EXCHANGE};
      assert.equal(await recoverTypedDataAddress({domain,types,primaryType:'Order',message,signature}),this.account.address);
      const digest=hashTypedData({domain,types,primaryType:'Order',message});const order={id:`order-${this.orders.size+1}`,status:'LIVE',...data.order,ownerId:42,clientOrderId:data.clientOrderId};
      const row={order,execution:{matched:false,settlementStatus:this.delay?'DELAYED':'UNMATCHED',totalsRaw:{contractsGross:'0',contractsFee:'0',contractsNet:'0',usdGross:'0',usdFee:'0',usdNet:'0'},clientOrderId:data.clientOrderId},digest,request:data};this.orders.set(data.clientOrderId,row);
      if(!this.delay&&!data.postOnly)this.fill(data.clientOrderId);
      if(this.dropSubmit){this.dropSubmit=false;res.destroy();return;}this.reply(res,201,{order:row.order,execution:row.execution});return;
    }
    if(url.pathname==='/orders/status/batch'){
      this.reply(res,200,{results:data.orders.map((x:Json,index:number)=>{const row=this.orders.get(x.clientOrderId);return row?{index,status:'found',clientOrderId:x.clientOrderId,orderId:row.order.id,data:{order:row.order,execution:{...row.execution,settlementStatus:this.invalidStatus?'NEW_UNDOCUMENTED_STATE':row.execution.settlementStatus}}}:{index,status:'not_found'};})});return;
    }
    if(url.pathname.startsWith('/orders/')&&req.method==='DELETE'){
      const row=[...this.orders.values()].find(r=>r.order.id===url.pathname.split('/').at(-1));if(!row){this.reply(res,404,{});return;}
      if(this.cancelRace)this.fill(row.order.clientOrderId);
      row.order.status='CANCELED';row.execution.settlementStatus=row.execution.matched?'CONFIRMED':'CANCELED';this.reply(res,200,{message:'cancelled'});return;
    }
    this.reply(res,404,{message:'fixture route missing'});
  }
  fill(clientOrderId:string):void {
    const row=this.orders.get(clientOrderId)!;const o=row.order;const buy=o.side===0;const remaining=BigInt(o.makerAmount)-BigInt(row.filledRaw??'0');const offered=remaining*this.fillNumerator/this.fillDenominator;if(!offered)return;
    const p=BigInt(Math.round((buy?Number(o.price):Number(o.price))*1e6)),usd=buy?offered:offered*p/1000000n,shares=buy?offered*1000000n/p:offered;
    const sharesFee=row.request.postOnly||this.collateral||!buy?0n:shares*300n/10000n;const fee=row.request.postOnly?0n:this.collateral?((500n*usd*(shares-usd)+5n*10000n*shares)/(10n*10000n*shares))*10n:buy?sharesFee:usd*300n/10000n;
    this.holdings.set(o.tokenId,(this.holdings.get(o.tokenId)??0n)+(buy?shares-sharesFee:-shares));this.usdc+=buy?-usd-(this.collateral?fee:0n):usd-fee;this.block++;
    const txHash=keccak256(toHex(`fixture-fill-${this.block}`));const topics=encodeEventTopics({abi,eventName:'OrderFilled',args:{orderHash:row.digest,maker:this.account.address,taker:zeroAddress}});
    const logs=[this.log(EXCHANGE,topics,encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[buy?0n:BigInt(o.tokenId),buy?BigInt(o.tokenId):0n,buy?usd:shares,buy?shares:usd,this.collateral?0n:fee]),txHash,0)];
    if(this.collateral&&fee)logs.push(this.log(USDC,encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from:this.account.address,to:FEE}}),encodeAbiParameters([{type:'uint256'}],[fee]),txHash,1));
    this.receipts.set(txHash,this.receipt(txHash,logs));row.filledRaw=(BigInt(row.filledRaw??'0')+offered).toString();row.order.status=BigInt(row.filledRaw)>=BigInt(o.makerAmount)?'MATCHED':'LIVE';
    row.execution={matched:true,settlementStatus:'CONFIRMED',clientOrderId,tradeEventId:`event-${this.block}`,txHash,feeRateBps:o.feeRateBps,effectiveFeeBps:0,totalsRaw:{contractsGross:shares.toString(),contractsFee:sharesFee.toString(),contractsNet:(shares-sharesFee).toString(),usdGross:usd.toString(),usdFee:(this.collateral||!buy?fee:0n).toString(),usdNet:(buy?usd:usd-fee).toString()}};
    this.history.push({blockTimestamp:Math.floor(Date.now()/1000),market:{slug:'fixture-market'},strategy:buy?'Limit Buy':'Limit Sell',transactionHash:txHash});
  }
  private blockHash(n:number):Hex{return `0x${n.toString(16).padStart(64,'0')}`;}
  private log(address:Address,topics:readonly unknown[],data:Hex,txHash:Hex,index:number):Json{return{address,topics,data,blockNumber:toHex(this.block),blockHash:this.blockHash(this.block),transactionHash:txHash,transactionIndex:'0x0',logIndex:toHex(index),removed:false};}
  private receipt(txHash:Hex,logs:Json[]):Json{return{transactionHash:txHash,blockHash:this.blockHash(this.block),blockNumber:toHex(this.block),transactionIndex:'0x0',from:this.account.address,to:EXCHANGE,status:this.failChain?'0x0':'0x1',type:'0x2',l1Fee:'0x0',operatorFeeScalar:'0x0',operatorFeeConstant:'0x0',effectiveGasPrice:'0x1',gasUsed:'0x5208',cumulativeGasUsed:'0x5208',contractAddress:null,logs,logsBloom:`0x${'0'.repeat(512)}`};}
  private async rpc(method:string,params:any[]):Promise<unknown>{
    if(method==='eth_chainId')return toHex(this.chainId);
    if(method==='eth_getCode')return this.code;
    if(method==='eth_getBalance')return '0xde0b6b3a7640000';
    if(method==='eth_getBlockByNumber') {const n=typeof params[0]==='string'&&params[0].startsWith('0x')?Number(BigInt(params[0])):this.block;return{number:toHex(n),hash:this.blockHash(n),parentHash:this.blockHash(n-1),timestamp:toHex(this.blockTimes.get(n) ?? (this.blockTimes.set(n,Math.floor(Date.now()/1000)),this.blockTimes.get(n)!)),baseFeePerGas:'0x1',gasLimit:'0x1c9c380',gasUsed:'0x0',transactions:[],nonce:'0x0000000000000000',difficulty:'0x0',totalDifficulty:'0x0',size:'0x1',miner:zeroAddress,extraData:'0x',logsBloom:`0x${'0'.repeat(512)}`,sha3Uncles:zeroHash,stateRoot:zeroHash,receiptsRoot:zeroHash,transactionsRoot:zeroHash};}
    if(method==='eth_maxPriorityFeePerGas'||method==='eth_gasPrice')return '0x1';
    if(method==='eth_estimateGas')return '0x10000';
    if(method==='eth_getTransactionCount')return toHex(this.nonce);
    if(method==='eth_getTransactionReceipt')return this.receipts.get(params[0] as unknown as Hex)??null;
    if(method==='eth_call'){
      const call=params[0];if(call.to.toLowerCase()==='0x420000000000000000000000000000000000000f')return encodeAbiParameters([{type:'uint256'}],[0n]);const decoded=decodeFunctionData({abi:[...erc20Abi,...erc1155Abi,...abi],data:call.data});const args=decoded.args as readonly unknown[];let value:bigint|boolean=0n;
      if(decoded.functionName==='balanceOf')value=call.to.toLowerCase()===USDC.toLowerCase()?this.usdc:this.holdings.get(String(args[1]))??0n;
      if(decoded.functionName==='allowance')value=this.allApproved?2n**255n:this.allowances.get(String(args[1]).toLowerCase())??0n;
      if(decoded.functionName==='isApprovedForAll')value=this.allApproved||this.operators.has(String(args[1]).toLowerCase());
      if(decoded.functionName==='payoutDenominator')value=this.resolved?1n:0n;
      if(decoded.functionName==='payoutNumerators')value=BigInt(String(args[1]))===0n?1n:0n;
      return typeof value==='boolean'?encodeAbiParameters([{type:'bool'}],[value]):encodeAbiParameters([{type:'uint256'}],[value]);
    }
    if(method==='eth_sendRawTransaction'){
      const serialized=params[0] as unknown as Hex;const tx=parseTransaction(serialized);assert.equal(tx.chainId,8453);assert.equal(tx.nonce,this.nonce);this.nonce++;this.block++;
      const id=keccak256(serialized),logs:Json[]=[];
      if(!this.failChain){const d=decodeFunctionData({abi:[...erc20Abi,...erc1155Abi,...abi],data:tx.data!});const a=d.args as readonly unknown[];
        if(d.functionName==='approve')this.allowances.set(String(a[0]).toLowerCase(),BigInt(String(a[1])));
        if(d.functionName==='setApprovalForAll')this.operators.add(String(a[0]).toLowerCase());
        if(d.functionName==='redeemPositions'){const payout=this.holdings.get('10')??0n;this.usdc+=payout;this.holdings.set('10',0n);this.holdings.set('11',0n);if(payout)logs.push(this.log(USDC,encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from:CTF,to:this.account.address}}),encodeAbiParameters([{type:'uint256'}],[payout]),id,0));}
      }
      this.receipts.set(id,this.receipt(id,logs));return id;
    }
    throw new Error(`FIXTURE_RPC_UNSUPPORTED:${method}`);
  }
}
