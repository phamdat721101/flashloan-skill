import { readFileSync } from 'node:fs';
import { parseAeroRequest, type AeroRequest } from '../aero/types.js';
export function aeroFixture():AeroRequest {
  const envelope=JSON.parse(readFileSync('docs/features/aero-split-routing.spec.json','utf8'));
  return parseAeroRequest(envelope.data_contracts.inputs.example);
}
