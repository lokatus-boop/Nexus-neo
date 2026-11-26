import type { NexusApi } from '../preload/preload';

declare global {
  interface Window {
    nexus: NexusApi;
  }
}

export const api = window.nexus;

export function uid(): string {
  return crypto.randomUUID();
}
