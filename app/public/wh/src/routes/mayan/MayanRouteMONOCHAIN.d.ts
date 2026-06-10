import { Chain, Network, routes } from '@wormhole-foundation/sdk-connect';
import { MayanRouteBase } from './MayanRouteBase';
import { MayanProtocol, TransferParams, ValidationResult } from './types';
export declare class MayanRouteMONOCHAIN<N extends Network> extends MayanRouteBase<N> implements routes.StaticRouteMethods<typeof MayanRouteMONOCHAIN> {
    static meta: {
        name: string;
        provider: string;
    };
    protocols: MayanProtocol[];
    validate(request: routes.RouteTransferRequest<N>, params: TransferParams): Promise<ValidationResult>;
    static supportsSameChainSwaps(network: Network, chain: Chain): boolean;
}
//# sourceMappingURL=MayanRouteMONOCHAIN.d.ts.map