import { Chain } from '@wormhole-foundation/sdk';
type SearchState = {
    txHash?: string;
    chain?: Chain;
};
export declare const setSearch: import('@reduxjs/toolkit').ActionCreatorWithPayload<{
    txHash: string;
    chain: Chain;
}, "search/setSearch">, clearSearch: import('@reduxjs/toolkit').ActionCreatorWithoutPayload<"search/clearSearch">;
declare const _default: import('@reduxjs/toolkit').Reducer<SearchState>;
export default _default;
//# sourceMappingURL=search.d.ts.map