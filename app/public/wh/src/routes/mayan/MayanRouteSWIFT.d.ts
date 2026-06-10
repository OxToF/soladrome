import { Network } from '@wormhole-foundation/sdk-base';
import { routes } from '@wormhole-foundation/sdk-connect';
import { MayanRouteCrossChain } from './MayanRouteCrossChain';
import { MayanProtocol } from './types';
export declare class MayanRouteSWIFT<N extends Network> extends MayanRouteCrossChain<N> implements routes.StaticRouteMethods<typeof MayanRouteSWIFT> {
    static meta: {
        name: string;
        provider: string;
    };
    protocols: MayanProtocol[];
}
//# sourceMappingURL=MayanRouteSWIFT.d.ts.map