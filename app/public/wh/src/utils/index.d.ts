import { ChainConfig } from '../config/types';
import { Token } from '../config/tokens';
import { Chain, Platform, amount as sdkAmount } from '@wormhole-foundation/sdk';
export declare const MAX_DECIMALS = 6;
export declare const NORMALIZED_DECIMALS = 8;
export declare function convertAddress(address: string): string;
export declare function trimAddress(address: string, max?: number): string;
export declare function trimTxHash(txHash: string, headLength?: number, tailLength?: number): string;
export declare function displayAddress(chain: Chain, address: string): string;
export declare function displayWalletAddress(walletType: Platform | undefined, address: string): string;
export declare function getChainConfig(chain: Chain): ChainConfig;
export declare function getGasToken(chain: Chain): Token;
export declare function getTokenDisplaySymbolByTokenAddress(token: Token): string;
export declare function chainDisplayName(chain: Chain): string;
export declare function copyTextToClipboard(text: string): boolean;
export declare function hexPrefix(hex: string): string;
export declare function isValidTxId(chain: Chain, tx: string): boolean;
export declare function usePrevious<T>(value: T): T | undefined;
export declare function sleep(timeout: number): Promise<unknown>;
export declare function hydrateHrefTemplate(href: string, fromChain?: string, toChain?: string): string;
export declare function isEqualCaseInsensitive(a: string, b: string): boolean;
export declare const getUSDFormat: (price: number | undefined) => string;
export declare const calculateUSDPriceRaw: (getTokenPrice: number | ((token: Token) => number | undefined), amount?: sdkAmount.Amount | number, token?: Token) => number | undefined;
export declare const calculateUSDPrice: (getTokenPrice: (token: Token) => number | undefined, amount?: sdkAmount.Amount | number, token?: Token) => string;
/**
 * Checks whether an object is empty.
 *
 * isEmptyObject(null)
 * // => true
 *
 * isEmptyObject(undefined)
 * // => true
 *
 * isEmptyObject({})
 * // => true
 *
 * isEmptyObject({ 'a': 1 })
 * // => false
 */
export declare const isEmptyObject: (value: object | null | undefined) => boolean;
export type ExplorerPathType = 'wallet' | 'tx' | 'token';
export declare const getTokenExplorerUrl: (chain: Chain, path: string) => string | undefined;
export declare const getTransactionExplorerUrl: (chain: Chain, path: string) => string | undefined;
export declare const getWalletExplorerUrl: (chain: Chain, path: string) => string | undefined;
export declare const isFrankensteinToken: (token: Token, chain: Chain) => boolean;
export declare const isStableCoin: (token: Token) => boolean;
export declare const millisToHumanString: (ts: number) => string;
export declare const millisToRelativeTime: (ts: number) => string;
export declare const formatDuration: (seconds: number) => string;
export declare const isExecutorRoute: (route: string | undefined) => boolean;
export declare const stringifyWithBigInt: (json: any) => string;
//# sourceMappingURL=index.d.ts.map