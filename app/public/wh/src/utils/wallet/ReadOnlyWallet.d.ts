import { Address, ChainId, IconSource, SendTransactionResult, Wallet } from '@wormhole-labs/wallet-aggregator-core';
import { Chain, NativeAddress } from '@wormhole-foundation/sdk';
export declare class ReadOnlyWallet extends Wallet {
    readonly _address: NativeAddress<Chain>;
    readonly _chain: Chain;
    private _isConnected;
    static readonly NAME = "ReadOnlyWallet";
    constructor(_address: NativeAddress<Chain>, _chain: Chain);
    getName(): string;
    getUrl(): string;
    connect(): Promise<Address[]>;
    disconnect(): Promise<void>;
    getChainId(): ChainId;
    getNetworkInfo(): void;
    getAddress(): Address;
    getAddresses(): Address[];
    setMainAddress(address: Address): void;
    getBalance(): Promise<string>;
    isConnected(): boolean;
    getIcon(): IconSource;
    signTransaction(tx: any): Promise<any>;
    sendTransaction(tx: any): Promise<SendTransactionResult<any>>;
    signMessage(msg: any): Promise<any>;
    signAndSendTransaction(tx: any): Promise<SendTransactionResult<any>>;
    getFeatures(): string[];
    supportsChain(chainId: ChainId): boolean;
}
//# sourceMappingURL=ReadOnlyWallet.d.ts.map