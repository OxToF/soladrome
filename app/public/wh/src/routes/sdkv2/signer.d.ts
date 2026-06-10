import { Network, Chain, ChainContext, UnsignedTransaction, Signer, SignAndSendSigner, TxHash } from '@wormhole-foundation/sdk';
import { TransferWallet } from '../../utils/wallet';
import { WormholeConnectWalletProvider } from '../../utils/wallet/types';
export declare class SDKv2Signer<N extends Network, C extends Chain> implements SignAndSendSigner<N, C> {
    _chain: Chain;
    _chainContextV2: ChainContext<N, C>;
    _address: string;
    _walletType: TransferWallet;
    _walletProvider: WormholeConnectWalletProvider;
    constructor(chain: Chain, chainContextV2: ChainContext<N, C>, address: string, walletType: TransferWallet, walletProvider: WormholeConnectWalletProvider);
    static fromChain<N extends Network, C extends Chain>(chain: Chain, address: string, walletType: TransferWallet, walletProvider: WormholeConnectWalletProvider): Promise<SDKv2Signer<N, C>>;
    static fromPrivateKey<N extends Network, C extends Chain>(chain: Chain): Promise<Signer<N, C>>;
    signAndSend(txs: UnsignedTransaction<N, C>[]): Promise<TxHash[]>;
    chain(): C;
    address(): string;
    provider(): WormholeConnectWalletProvider;
}
//# sourceMappingURL=signer.d.ts.map