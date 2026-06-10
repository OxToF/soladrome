import { routes } from '@wormhole-foundation/sdk';
import { NttRoute, NttExecutorRoute, nttExecutorRoute, nttManualRoute } from '@wormhole-foundation/sdk-route-ntt';
declare const nttRoutes: (nc: NttRoute.Config, executorOptions?: Omit<NttExecutorRoute.Config, "ntt">) => routes.RouteConstructor[];
export { nttExecutorRoute, nttManualRoute, nttRoutes, NttRoute, NttExecutorRoute, };
//# sourceMappingURL=ntt.d.ts.map