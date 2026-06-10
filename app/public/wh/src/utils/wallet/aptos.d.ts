import { Wallet } from '@wormhole-labs/wallet-aggregator-core';
import { Network } from '@wormhole-foundation/sdk';
import { AptosUnsignedTransaction, AptosChains } from '@wormhole-foundation/sdk-aptos';
export declare function fetchOptions(): Record<string, Wallet>;
export declare function signAndSendTransaction(request: AptosUnsignedTransaction<Network, AptosChains>, wallet: Wallet): Promise<import('@wormhole-labs/wallet-aggregator-core').SendTransactionResult<any>>;
//# sourceMappingURL=aptos.d.ts.map