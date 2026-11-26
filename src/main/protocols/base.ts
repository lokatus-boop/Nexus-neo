import { EventEmitter } from 'node:events';
import type { AuthPrompt, ConnState, HostKeyPrompt } from '../../shared/types';

/** Interfaz común de cualquier conexión que alimenta un terminal. */
export abstract class TerminalConnection extends EventEmitter {
  state: ConnState = 'connecting';

  abstract open(cols: number, rows: number): Promise<void>;
  abstract write(data: string): void;
  abstract resize(cols: number, rows: number): void;
  abstract close(): void;

  protected emitData(data: string | Buffer): void {
    this.emit('data', typeof data === 'string' ? data : data.toString('utf8'));
  }

  protected setState(state: ConnState, message?: string): void {
    this.state = state;
    this.emit('state', state, message);
  }
}

/** Preguntas interactivas que una conexión puede hacer al usuario. */
export interface Prompter {
  hostKey(p: HostKeyPrompt): Promise<boolean>;
  auth(p: AuthPrompt): Promise<string[] | null>;
}
