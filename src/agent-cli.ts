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
console.log(`Installed flashloan-agent skill in ${resolve(skillRoot, 'flashloan-agent')}`);
