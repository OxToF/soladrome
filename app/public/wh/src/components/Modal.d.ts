import { JSX } from 'react';
type Props = {
    open: boolean;
    children: JSX.Element | JSX.Element[];
    width: number;
    onClose: () => any;
    closable?: boolean;
};
declare function Modal({ open, width, closable, children, onClose }: Props): JSX.Element;
export default Modal;
//# sourceMappingURL=Modal.d.ts.map