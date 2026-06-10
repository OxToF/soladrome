import { ChainId } from '@lifi/sdk';
import { Chain } from '@wormhole-foundation/sdk-connect';
export declare const DEFAULT_SLIPPAGE_PERCENT = 0.005;
export declare const DEFAULT_MAX_PRICE_IMPACT_PERCENT = 0.2;
export declare const DEFAULT_ETA_SECONDS = 60;
export declare const DEFAULT_TIMEOUT: number;
export declare const DEFAULT_BRIDGES: {
    deny: string[];
};
export declare const DEFAULT_EXCHANGES: {};
export declare const MILLISECONDS_PER_SECOND = 1000;
export declare const POLLING_INTERVAL_MS = 5000;
export declare const LIFI_NATIVE_ADDRESS_EVM = "0x0000000000000000000000000000000000000000";
export declare const LIFI_NATIVE_ADDRESS_SVM = "11111111111111111111111111111111";
export declare const LIFI_NATIVE_ADDRESS_SUI = "0x2::sui::SUI";
export declare const CHAIN_ID_MAP: Partial<Record<Chain, ChainId>>;
export declare const CHAIN_FROM_ID_MAP: Record<number, Chain>;
export declare const DEFAULT_INTEGRATOR = "lifi-sdk";
export declare const DEFAULT_API_URL = "https://li.quest/v1";
//# sourceMappingURL=consts.d.ts.map