import { ChainResourceMap, WormholeConfig } from '../sdklegacy';
import { Network, Wormhole as WormholeV2, Chain, AttestationReceipt, routes, IndexerConfig } from '@wormhole-foundation/sdk';
import { PriorityFeeOptions } from '@wormhole-foundation/sdk-solana';
import { TransferDetails, TriggerEventHandler, WormholeConnectEventHandler } from '../telemetry/types';
import { default as RouteOperator } from '../routes/operator';
import { UiConfig } from './ui';
import { TransferInfo } from '../utils/sdkv2';
import { Token, TokenCache, TokenTuple } from './tokens';
export * from './ui';
export declare enum TokenIcon {
    'AVAX' = 1,
    'BNB' = 2,
    'BSC' = 3,
    'CELO' = 4,
    'ETH' = 5,
    'FANTOM' = 6,
    'POLYGON' = 7,
    'SOLANA' = 8,
    'USDC' = 9,
    'GLMR' = 10,
    'DAI' = 11,
    'USDT' = 12,
    'BUSD' = 13,
    'WBTC' = 14,
    'SUI' = 15,
    'APT' = 16,
    'SEI' = 17,
    'BASE' = 18,
    'OSMO' = 19,
    'TBTC' = 20,
    'WSTETH' = 21,
    'ARBITRUM' = 22,
    'OPTIMISM' = 23,
    'ATOM' = 24,
    'EVMOS' = 25,
    'KUJI' = 26,
    'PYTH' = 27,
    'INJ' = 28,
    'KLAY' = 29,
    'NTT' = 30,
    'SCROLL' = 31,
    'XLAYER' = 32,
    'MANTLE' = 33,
    'WORLDCHAIN' = 34,
    'BERA' = 35,
    'INK' = 36,
    'BTC' = 37,
    'SONIC' = 38,
    'PLUME' = 39,
    'FOGO' = 40,
    'HYPE' = 41,
    'XRP' = 42,
    'CTC' = 43,
    'MONAD' = 44,
    'AUSD' = 45,
    'MOCA' = 46
}
export type TransferSide = 'source' | 'destination';
export interface ExtendedTransferDetails extends TransferDetails {
    fromWalletAddress: string;
    toWalletAddress: string;
}
export interface ValidateTransferResult {
    isValid: boolean;
    error?: string;
}
export type ValidateTransferHandler = (transferDetails: ExtendedTransferDetails) => Promise<ValidateTransferResult>;
export type IsChainSupportedHandler = (chain: Chain, type: 'source' | 'destination', network?: Network, oppositeChain?: Chain) => boolean;
export type IsRouteSupportedHandler = (transferDetails: TransferDetails) => Promise<boolean>;
export type IsTokenSupportedHandler = (token: Token, sourceToken?: Token, // The selected source token, if applicable
tokenListType?: 'source' | 'destination') => boolean;
export interface WormholeConnectConfig {
    network?: Network;
    rpcs?: ChainResourceMap;
    evmIndexers?: IndexerConfig;
    coingecko?: {
        apiKey?: string;
        customUrl?: string;
    };
    chains?: Chain[];
    tokens?: (string | TokenTuple)[];
    routes?: routes.RouteConstructor<any>[];
    tokensConfig?: TokensConfig;
    cacheNamespace?: string;
    wrappedTokens?: WrappedTokenAddresses;
    eventHandler?: WormholeConnectEventHandler;
    validateTransferHandler?: ValidateTransferHandler;
    isChainSupportedHandler?: IsChainSupportedHandler;
    isRouteSupportedHandler?: IsRouteSupportedHandler;
    isTokenSupportedHandler?: IsTokenSupportedHandler;
    filterRoutes?: (routes: string[]) => string[];
    ui?: UiConfig;
    transactionSettings?: TransactionSettings;
}
export interface InternalConfig<N extends Network> {
    network: N;
    _v2Wormhole?: WormholeV2<N>;
    sdkConfig: WormholeConfig;
    isMainnet: boolean;
    rpcs: ChainResourceMap;
    evmIndexers?: IndexerConfig;
    mayanApi: string;
    lifiExplorerUrl: string;
    wormholeApi: string;
    wormholeRpcHosts: string[];
    coingecko?: {
        apiKey?: string;
        customUrl?: string;
    };
    tokens: TokenCache;
    tokenWhitelist?: (string | TokenTuple)[];
    chains: ChainsConfig;
    chainsArr: ChainConfig[];
    routes: RouteOperator;
    triggerEvent: TriggerEventHandler;
    validateTransfer?: ValidateTransferHandler;
    isChainSupportedHandler?: IsChainSupportedHandler;
    isRouteSupportedHandler?: IsRouteSupportedHandler;
    isTokenSupportedHandler?: IsTokenSupportedHandler;
    filterRoutes?: (routes: string[]) => string[];
    ui: UiConfig;
    cacheKey: (name: string) => string;
    guardianSet: GuardianSetData;
    transactionSettings: TransactionSettings;
}
export type TokenConfig = {
    symbol: string;
    name?: string;
    decimals: number;
    icon: TokenIcon | string;
    tokenId: {
        chain: Chain;
        address: string;
    };
};
export type TokensConfig = {
    [key: string]: TokenConfig;
};
export interface ChainConfig {
    sdkName: Chain;
    displayName: string;
    explorerUrl: string;
    explorerName: string;
    icon: Chain;
    symbol?: string;
    /**
     * Gas reserve amount to keep for the chain's native token.
     * This ensures users have enough gas to complete transactions.
     * Format: decimal string (e.g., '0.01' for 0.01 of the native token)
     *
     * Typical values:
     * - Ethereum: '0.01' ($30 notional)
     * - L2s (Base, Op, Arb): '0.001' ($3 notional)
     * - Other EVM L1s: '0.01'
     * - Solana: '0.01' ($1.3 notional)
     */
    gasReserve?: string;
}
export type ChainsConfig = {
    [chain in Chain]?: ChainConfig;
};
export type RpcMapping = {
    [chain in Chain]?: string;
};
export type GuardianSetData = {
    index: number;
    keys: string[];
};
export type NetworkData = {
    chains: ChainsConfig;
    tokens: TokenConfig[];
    wrappedTokens: WrappedTokenAddresses;
    rpcs: RpcMapping;
    guardianSet: GuardianSetData;
};
export type WrappedTokenAddresses = {
    [chain in Chain]?: {
        [address: string]: {
            [otherChain in Chain]?: string;
        };
    };
};
export interface Transaction {
    txHash: string;
    sender?: string;
    recipient: string;
    amount?: string;
    amountUsd?: number;
    receiveAmount?: string;
    fromChain: Chain;
    fromToken?: Token;
    toChain: Chain;
    toToken?: Token;
    senderTimestamp: string;
    receiverTimestamp?: string;
    explorerLink: string;
    inProgress: boolean;
}
export interface TransactionLocal {
    receipt: routes.Receipt<AttestationReceipt>;
    route: string;
    timestamp: number;
    txHash: string;
    txDetails: TransferInfo;
    isReadyToClaim?: boolean;
}
export interface TransactionSettings {
    Solana?: {
        priorityFee?: PriorityFeeOptions;
    };
}
//# sourceMappingURL=types.d.ts.map