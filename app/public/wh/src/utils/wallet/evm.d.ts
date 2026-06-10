import { Wallet } from '@wormhole-labs/wallet-aggregator-core';
import { Eip6963Wallet, InjectedWallet, WalletConnectWallet } from '@wormhole-labs/wallet-aggregator-evm';
import { EvmUnsignedTransaction, EvmChains } from '@wormhole-foundation/sdk-evm';
import { Network } from '@wormhole-foundation/sdk';
export declare const getWallets: () => {
    walletConnect?: WalletConnectWallet | undefined;
    okxwallet: Eip6963Wallet;
    injected: InjectedWallet;
};
export interface AssetInfo {
    address: string;
    symbol: string;
    decimals: number;
    chainId?: number;
}
export declare function signAndSendTransaction(request: EvmUnsignedTransaction<Network, EvmChains>, w: Wallet, chainName: string): Promise<string>;
//# sourceMappingURL=evm.d.ts.map