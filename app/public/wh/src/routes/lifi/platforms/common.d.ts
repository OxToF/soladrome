import { Chain, TransactionId, Network, Signer } from '@wormhole-foundation/sdk-connect';
import { EvmPlatform } from '@wormhole-foundation/sdk-evm';
import { SolanaPlatform } from '@wormhole-foundation/sdk-solana';
import { SuiPlatform } from '@wormhole-foundation/sdk-sui';
export declare function executeTransaction<N extends Network>(txReq: any, signer: Signer<N>, rpc: any, chain: Chain, platform: typeof SolanaPlatform | typeof SuiPlatform | typeof EvmPlatform, txs: TransactionId[]): Promise<void>;
//# sourceMappingURL=common.d.ts.map