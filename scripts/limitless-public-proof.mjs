import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadPredictionConfig } from '../dist/prediction/config.js';
import { PredictionRuntime } from '../dist/prediction/runtime.js';

// Public reads only. No dotenv, account authentication, signer or funded action.
const config = await loadPredictionConfig('config/prediction/base.example.json');
const result = await new PredictionRuntime(config).run({ schemaVersion: 'prediction-request/1', requestId: 'limitless-public-proof', command: 'doctor', payload: { mode: 'paper', publicOnly: true } });
const ready = result.data?.kind === 'doctor' && result.data.ready === true;
const evidence = { source: 'independent-public-api-and-base-rpc', buildId: createHash('sha256').update(JSON.stringify(result)).digest('hex'), target: 'Base 8453 / Limitless public reads', timestamp: new Date().toISOString(), health: ready ? 'PUBLIC_READS_VERIFIED' : 'PUBLIC_READS_BLOCKED', clientAcceptance: 'Funded execution NOT_RUN; public data only.', result };
await mkdir('.nim/deliver', { recursive: true });
await writeFile('.nim/deliver/prediction-public-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
process.exitCode = ready ? 0 : 1;
