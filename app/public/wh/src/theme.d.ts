import { PaletteMode, Theme } from '@mui/material';
import { default as Color } from 'color';
export type WormholeConnectTheme = {
    mode: PaletteMode;
    background?: string;
    formBackground?: string;
    formBorder?: string;
    input?: string;
    inputFillTreatment?: boolean;
    primary?: string;
    secondary?: string;
    text?: string;
    textSecondary?: string;
    error?: string;
    success?: string;
    font?: string;
};
type Color = {
    main: string;
};
export type InternalTheme = {
    mode: PaletteMode;
    primary: Color;
    secondary: Color;
    divider: string;
    background: {
        default: string;
    };
    text: {
        primary: string;
        secondary: string;
        tertiary: string;
        accent: string;
    };
    error: Color;
    info: Color;
    success: Color;
    warning: Color;
    button: {
        primary: string;
        primaryText: string;
        disabled: string;
        disabledText: string;
        action: string;
        actionText: string;
        hover: string;
    };
    options: {
        hover: string;
        select: string;
    };
    card: {
        background: string;
        elevation: string;
        secondary: string;
    };
    popover: {
        background: string;
        elevation: string;
        secondary: string;
    };
    input: {
        background: string;
        border: string;
        fillTreatment: boolean;
    };
    icon: {
        primary: string;
        secondary: string;
    };
    toggle: {
        background: string;
        text: string;
        active: string;
        activeText: string;
    };
    formContainer: {
        background: string;
        border: string;
    };
    font: string;
    logo: string;
};
export declare const light: InternalTheme;
export declare const dark: InternalTheme;
export declare const generateTheme: (customTheme: WormholeConnectTheme) => Theme;
export {};
//# sourceMappingURL=theme.d.ts.map