import { Chain } from '@wormhole-foundation/sdk';
type ExternalSearch = {
    hasExternalSearch?: boolean;
    txHash?: string;
    chain?: Chain;
    clear: () => void;
};
export declare function useExternalSearch(): ExternalSearch;
export {};
//# sourceMappingURL=useExternalSearch.d.ts.map