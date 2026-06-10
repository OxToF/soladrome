import { Chain, Network, amount as sdkAmount } from '@wormhole-foundation/sdk';
import { WormholeConnectConfig } from '../config/types';
import { Token } from '../config/tokens';
import { TransferWallet } from '../utils/wallet';
export interface LoadEvent {
    type: 'load';
    config?: WormholeConnectConfig;
}
export interface UpdateConfigEvent {
    type: 'config';
    config?: WormholeConnectConfig;
}
export interface TransferDetails {
    route: string;
    fromToken: TokenDetails;
    toToken: TokenDetails;
    fromChain: Chain;
    toChain: Chain;
    txId?: string;
    USDAmount?: number;
    amount?: sdkAmount.Amount;
}
export type TransferEventType = 'transfer.initiate' | 'transfer.start' | 'transfer.success' | 'transfer.refunded' | 'transfer.redeem.initiate' | 'transfer.redeem.start' | 'transfer.redeem.success';
export interface TransferEvent {
    type: TransferEventType;
    details: TransferDetails;
}
export interface TransferErrorEvent {
    type: 'transfer.error' | 'transfer.redeem.error';
    details: TransferDetails;
    error: TransferError;
}
export interface TransferError {
    type: TransferErrorType;
    original: any;
}
export interface TokenDetails {
    symbol: string;
    tokenId: {
        address: string;
        chain: string;
    } | 'native';
}
export declare const ERR_INSUFFICIENT_ALLOWANCE = "insufficient_allowance";
export declare const ERR_NOT_ENOUGH_CAPACITY = "swap_failed";
export declare const ERR_SOURCE_CONTRACT_PAUSED = "source_contract_paused";
export declare const ERR_DESTINATION_CONTRACT_PAUSED = "destination_contract_paused";
export declare const ERR_UNSUPPORTED_ABI_VERSION = "unsupported_abi_version";
export declare const ERR_INSUFFICIENT_GAS = "insufficient_gas";
export declare const ERR_INSUFFICIENT_FUNDS = "insufficient_funds";
export declare const ERR_AMOUNT_TOO_LARGE = "amount_too_large";
export declare const ERR_AMOUNT_TOO_SMALL = "amount_too_small";
export declare const ERR_USER_REJECTED = "user_rejected";
export declare const ERR_TIMEOUT = "user_timeout";
export declare const ERR_UNKNOWN = "unknown";
export declare const ERR_RELAY_FAILED = "relay_failed";
export declare const ERR_SLIPPAGE_EXCEEDED = "slippage_exceeded";
export type TransferErrorType = typeof ERR_INSUFFICIENT_ALLOWANCE | typeof ERR_NOT_ENOUGH_CAPACITY | typeof ERR_SOURCE_CONTRACT_PAUSED | typeof ERR_DESTINATION_CONTRACT_PAUSED | typeof ERR_UNSUPPORTED_ABI_VERSION | typeof ERR_INSUFFICIENT_GAS | typeof ERR_INSUFFICIENT_FUNDS | typeof ERR_AMOUNT_TOO_LARGE | typeof ERR_AMOUNT_TOO_SMALL | typeof ERR_USER_REJECTED | typeof ERR_TIMEOUT | typeof ERR_RELAY_FAILED | typeof ERR_SLIPPAGE_EXCEEDED | typeof ERR_UNKNOWN;
export interface ConnectWalletEvent {
    type: 'wallet.connect';
    details: {
        side: TransferWallet;
        chain: Chain;
        wallet: string;
        address: string | undefined;
    };
}
export interface HistoryLoadEvent {
    type: 'history.load';
    details: {
        wallet: string;
    };
}
export declare enum UserActions {
    SelectSrcToken = "select.src.token",
    SelectSrcChain = "select.src.chain",
    SelectDestToken = "select.dest.token",
    SelectDestChain = "select.dest.chain"
}
type UserActionValueMap = {
    [UserActions.SelectSrcToken]: Token;
    [UserActions.SelectDestToken]: Token;
    [UserActions.SelectSrcChain]: Chain;
    [UserActions.SelectDestChain]: Chain;
};
export type UserActionEvent<A extends UserActions = UserActions> = {
    type: 'user.action';
    details: {
        action: A;
        value: UserActionValueMap[A];
    };
};
export type UserActionEvents = {
    [A in UserActions]: UserActionEvent<A>;
}[UserActions];
export type WormholeConnectEventCore = LoadEvent | UpdateConfigEvent | TransferEvent | TransferErrorEvent | ConnectWalletEvent | HistoryLoadEvent | UserActionEvent;
export interface WormholeConnectEventMeta {
    meta: {
        version: string;
        hash: string;
        host?: string;
        network: Network;
    };
}
export type WormholeConnectEvent = WormholeConnectEventCore & WormholeConnectEventMeta;
export type TriggerEventHandler = (event: WormholeConnectEventCore) => void;
export type WormholeConnectEventHandler = (event: WormholeConnectEvent) => void;
export {};
//# sourceMappingURL=types.d.ts.map