import { SuiWallet } from '@wormhole-labs/wallet-aggregator-sui';
import { Wallet } from '@wormhole-labs/wallet-aggregator-core';
import { Network } from '@wormhole-foundation/sdk';
import { SuiUnsignedTransaction, SuiChains } from '@wormhole-foundation/sdk-sui';
export declare function fetchOptions(): Promise<{
    [key: string]: SuiWallet;
}>;
export declare const signAndSendTransaction: (request: SuiUnsignedTransaction<Network, SuiChains>, wallet: Wallet) => Promise<import('@wormhole-labs/wallet-aggregator-core').SendTransactionResult<any>>;
//# sourceMappingURL=sui.d.ts.map