import { cp, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillSource = resolve(here, '..', 'skills', 'flashloan-agent');

function usage(): never {
  throw new Error('usage: flashloan-agent install [--target <skills-directory>]');
}

const [command, flag, target] = process.argv.slice(2);
if (command !== 'install') usage();
if (flag && flag !== '--target') usage();
if (flag === '--target' && !target) usage();

const codexRoot = process.env.CODEX_HOME ?? resolve(homedir(), '.codex');
const skillRoot = target ?? resolve(codexRoot, 'skills');
await mkdir(skillRoot, { recursive: true });
await cp(skillSource, resolve(skillRoot, 'flashloan-agent'), { recursive: true, force: true });
// v7 SK-10: public contract, vectors and version manifests travel with the prompt. Never env files, .nim state or signing material.
const repoRoot = resolve(here, '..'), contracts = resolve(skillRoot, 'flashloan-agent', 'contracts');
await mkdir(contracts, { recursive: true });
for (const file of ['schemas/flashloan-integration-v1.schema.json', 'config/flashloan-versions.json', 'config/flashloan-integration-versions.json', 'config/admission-producers.json'])
  await cp(resolve(repoRoot, file), resolve(contracts, file.split('/').pop()!), { force: true });
await cp(resolve(repoRoot, 'schemas/examples/flashloan-integration-v1'), resolve(contracts, 'examples'), { recursive: true, force: true });
// v8: public deployment records the agent binds executors from (addresses, runtime hashes, pinned roots); no local state or secrets.
const deployments = resolve(contracts, 'deployments');
await mkdir(deployments, { recursive: true });
for (const file of ['base-native-v4-20261104.json', 'robinhood-native-v4-20261104.json', 'base-portable-roots-v8.json', 'base-executors.json', 'robinhood-executors.json', 'arbitrum-price-gap-executor-20261028.json'])
  await cp(resolve(repoRoot, 'docs/deployments', file), resolve(deployments, file), { force: true });
console.log(`Installed flashloan-agent skill in ${resolve(skillRoot, 'flashloan-agent')}`);
