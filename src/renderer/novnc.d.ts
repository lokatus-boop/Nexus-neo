declare module '@novnc/novnc/lib/rfb.js' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: unknown, options?: { credentials?: { password?: string; username?: string }; shared?: boolean });
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    sendCredentials(c: { password?: string; username?: string }): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
    focus(): void;
  }
}

declare module '@novnc/novnc/lib/util/logging.js' {
  export function initLogging(level: 'debug' | 'info' | 'warn' | 'error' | 'none'): void;
}
