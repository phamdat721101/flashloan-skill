#!/usr/bin/env node
// Extracts the finance wire contract and vectors from the PRD. Fails closed on digest drift.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const EXPECTED = '8046b6f9d4ef51f9419481ccee4e49c567681df9fb3f48867b9194cff3de4edb';
const prd = readFileSync(process.argv[2] ?? 'AI-FINANCE-UPGRADE-PRD.md', 'utf8');
const block = name => { const m = prd.match(new RegExp('```json ' + name + '\\n([\\s\\S]*?)\\n```')); if (!m) throw new Error(`missing ${name}`); return JSON.parse(m[1]); };
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',')}}` : JSON.stringify(v);
const schema = block('finance-contract');
const digest = createHash('sha256').update(canonical(schema)).digest('hex');
if (digest !== EXPECTED) { console.error(`CONTRACT_MISMATCH ${digest}`); process.exit(1); }
const bytes = JSON.stringify(schema, null, 2) + '\n';
writeFileSync('schemas/finance-v1.schema.json', bytes);
writeFileSync('schemas/examples/finance-v1.vectors.json', JSON.stringify(block('finance-examples'), null, 2) + '\n');
writeFileSync('config/finance/schema-version.json', JSON.stringify({ contractId: schema.$id, contractDigest: digest, fileSha256: createHash('sha256').update(bytes).digest('hex') }, null, 2) + '\n');
console.log(`finance contract ${digest}`);
