import { Network } from '@wormhole-foundation/sdk-base';
import { routes } from '@wormhole-foundation/sdk-connect';
import { MayanRouteBase } from './MayanRouteBase';
import { MayanProtocol } from './types';
export declare class MayanRoute<N extends Network> extends MayanRouteBase<N> implements routes.StaticRouteMethods<typeof MayanRoute> {
    static meta: {
        name: string;
        provider: string;
    };
    protocols: MayanProtocol[];
}
//# sourceMappingURL=MayanRoute.d.ts.map