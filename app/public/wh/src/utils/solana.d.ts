import { Connection, Transaction, VersionedTransaction } from '@solana/web3.js';
import { SolanaUnsignedTransaction } from '@wormhole-foundation/sdk-solana';
import { Chain, Network } from '@wormhole-foundation/sdk';
export type SolanaRpcProvider = 'triton' | 'helius' | 'ankr' | 'unknown';
export declare function setPriorityFeeInstructions(connection: Connection, blockhash: string, lastValidBlockHeight: number, request: SolanaUnsignedTransaction<Network>): Promise<Transaction | VersionedTransaction>;
export declare function isSvmChain(chain: Chain): boolean;
//# sourceMappingURL=solana.d.ts.map