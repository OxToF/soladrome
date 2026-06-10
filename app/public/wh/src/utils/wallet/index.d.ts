import { ChainConfig } from '../../config/types';
import { Wallet } from '@wormhole-labs/wallet-aggregator-core';
import { Network, Chain, UnsignedTransaction, Platform } from '@wormhole-foundation/sdk';
export * from './types';
export type { WormholeConnectWalletProvider } from './types';
export declare enum TransferWallet {
    SENDING = "sending",
    RECEIVING = "receiving"
}
export declare const walletAcceptedChains: (platform: Platform | undefined) => Chain[];
export declare const signAndSendTransaction: (chain: Chain, request: UnsignedTransaction<Network, Chain>, wallet: Wallet, options?: any) => Promise<string>;
export type WalletData = {
    name: string;
    type: Platform;
    icon: string;
    isReady: boolean;
    wallet: Wallet;
    description?: string;
};
export declare const getWalletOptions: (chain: ChainConfig | undefined) => Promise<WalletData[]>;
declare global {
    interface Window {
        ethereum?: any;
    }
}
//# sourceMappingURL=index.d.ts.map