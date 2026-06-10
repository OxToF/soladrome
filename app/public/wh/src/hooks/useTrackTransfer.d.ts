import { AttestationReceipt, routes, TokenId } from '@wormhole-foundation/sdk';
type Props = {
    route: string | undefined;
    receipt: routes.Receipt<AttestationReceipt> | null;
    eta?: Date;
    receivedTokenId?: TokenId;
};
type ReturnProps = {
    isCompleted: boolean;
    isReadyToClaim: boolean;
    receipt: routes.Receipt<AttestationReceipt> | undefined;
};
declare const useTrackTransfer: (props: Props) => ReturnProps;
export default useTrackTransfer;
//# sourceMappingURL=useTrackTransfer.d.ts.map