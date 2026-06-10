import { Wallet } from '@wormhole-labs/wallet-aggregator-core';
import { ConfirmOptions } from '@solana/web3.js';
import { SolanaWallet } from '@wormhole-labs/wallet-aggregator-solana';
import { SolanaUnsignedTransaction } from '@wormhole-foundation/sdk-solana';
import { Chain, Network } from '@wormhole-foundation/sdk';
export declare function fetchOptions(chain: Chain): {
    nightly: SolanaWallet;
};
export declare function fetchSolanaOptions(): {
    bitget: SolanaWallet;
    clover: SolanaWallet;
    coin98: SolanaWallet;
    solong: SolanaWallet;
    torus: SolanaWallet;
    nightly: SolanaWallet;
};
export declare function fetchFogoOptions(): {
    nightly: SolanaWallet;
};
/**
 * This function signs and sends the transaction while constantly checking for confirmation
 * and resending the transaction if it hasn't been confirmed after the specified interval
 * See https://docs.triton.one/chains/solana/sending-txs for more information.
 *
 * @param request The unsigned transaction to sign and send
 * @param wallet The wallet to use for signing and sending the transaction
 * @param options Optional confirmation options
 * @returns The transaction signature
 */
export declare function signAndSendTransactionWithResends(request: SolanaUnsignedTransaction<Network>, wallet: Wallet | undefined, options?: ConfirmOptions): Promise<string>;
//# sourceMappingURL=solana.d.ts.map