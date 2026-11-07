import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadPredictionConfig } from './config.js';
import { PredictionError, insist } from './contracts.js';
import { PredictionRuntime } from './runtime.js';

/** One bounded JSON request/result. No implicit dotenv loading, shell execution or key inspection. */
export async function predictionCli(args: string[], input: AsyncIterable<Uint8Array>, output: (line: string) => void): Promise<number> {
  try {
    const index = args.indexOf('--config');
    insist(index >= 0 && args[index + 1] && args.every((a, i) => i === index || i === index + 1 || a === '--fixture'), 'CLI_ARGUMENT_INVALID');
    const config = await loadPredictionConfig(args[index + 1]);
    insist(config.transportProfile !== 'fixture' || args.includes('--fixture'), 'FIXTURE_PROFILE_REQUIRES_EXPLICIT_FLAG');
    let bytes = Buffer.alloc(0);
    for await (const chunk of input) { insist(bytes.length + chunk.length <= 2 * 1024 * 1024, 'INPUT_LIMIT'); bytes = Buffer.concat([bytes, chunk]); }
    const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const result = await new PredictionRuntime(config).run(request);
    output(JSON.stringify(result) + '\n');
    return result.outcome === 'blocked' ? 2 : result.outcome === 'failed' ? 1 : 0;
  } catch (error) {
    const code = error instanceof PredictionError ? error.code : 'INPUT_OR_CONFIGURATION_INVALID';
    output(JSON.stringify({ schemaVersion: 'prediction-result/1', requestId: 'invalid', command: 'capabilities', mode: 'paper', outcome: 'blocked', data: null, errors: [{ code, retryable: false, recovery: 'Validate the versioned request and host configuration. No action was authorized.' }], evidence: [] }) + '\n');
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await predictionCli(process.argv.slice(2), process.stdin, line => process.stdout.write(line));
