import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

/** Decodes an operator secret only in memory and only for the supported Ed25519 scheme. */
export function loadSuiOperatorWallet(env: NodeJS.ProcessEnv = process.env): Ed25519Keypair {
  const encoded = env.SUI_OPERATOR_PRIVATE_KEY;
  if (!encoded) throw new Error('SUI_OPERATOR_PRIVATE_KEY is required for a signed transaction');
  if (!encoded.startsWith('suiprivkey')) {
    throw new Error('SUI_OPERATOR_PRIVATE_KEY must be a Bech32 suiprivkey value, never a raw hex key');
  }

  let decoded: ReturnType<typeof decodeSuiPrivateKey>;
  try {
    decoded = decodeSuiPrivateKey(encoded);
  } catch {
    throw new Error('SUI_OPERATOR_PRIVATE_KEY is not a valid Bech32 Sui private key');
  }
  if (decoded.scheme !== 'ED25519') {
    throw new Error('Only Ed25519 SUI_OPERATOR_PRIVATE_KEY values are supported by this utility');
  }
  return Ed25519Keypair.fromSecretKey(decoded.secretKey);
}
