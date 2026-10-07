import assert from 'node:assert/strict';
import test from 'node:test';
import { ArbitrumScanner } from '../scan/scanner.js';
import { loadScannerConfig } from '../scan/config.js';

const scannerConfigPath = process.env.E2E_ARBITRUM_SCANNER_CONFIG;

test('scans a configured Arbitrum RPC without a wallet or transaction send', { skip: !scannerConfigPath }, async () => {
  const config = await loadScannerConfig(scannerConfigPath!);
  const envelope = await new ArbitrumScanner(config).scanOnce();
  assert.equal(envelope.chainId, 42161);
  assert.equal(envelope.schemaVersion, '2.0');
  assert.match(envelope.observedBlock.hash, /^0x[\da-f]{64}$/i);
  assert.equal(Array.isArray(envelope.opportunities), true);
});
