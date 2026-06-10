import { Theme } from '@mui/material';
type Class = string | false;
export declare const joinClass: (classes: Class[]) => string;
export declare const NO_INPUT = "\u2014";
export declare const OPACITY: {
    0: string;
    5: string;
    7: string;
    10: string;
    15: string;
    20: string;
    25: string;
    30: string;
    35: string;
    40: string;
    45: string;
    50: string;
    55: string;
    60: string;
    65: string;
    70: string;
    75: string;
    80: string;
    85: string;
    90: string;
    95: string;
    100: string;
};
export declare const LINK: (theme: Theme) => {
    color: string;
    textDecoration: string;
    margin: string;
    display: string;
    alignItems: string;
    gap: string;
    cursor: string;
};
export declare const CENTER: {
    display: string;
    alignItems: string;
    justifyContent: string;
};
export declare const ROW: {
    display: string;
    alignItems: string;
    gap: string;
};
export declare const ROW_BETWEEN: {
    display: string;
    alignItems: string;
    justifyContent: string;
};
export declare const COL_CENTER: {
    display: string;
    flexDirection: string;
    justifyContent: string;
    gap: string;
};
export declare const ICON: {
    cursor: string;
    display: string;
    alignItems: string;
    justifyContent: string;
    width: string;
    height: string;
};
export declare const ERROR_BORDER: (theme: any) => {
    border: string;
};
export declare const changeOpacity: (color: string, opacity: keyof typeof OPACITY) => string;
export declare const useCustomScrollbar: () => object;
export {};
//# sourceMappingURL=style.d.ts.map